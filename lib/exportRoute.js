// Builds an Anki .apkg package from cards the browser already has loaded (see public/js/uploads.js: listCards()).
// This never reads the database: it only turns JSON the signed-in user already owns into a downloadable file, so
// the only thing checked is that the request carries a real session (free trial or member), not who owns which card.
const AnkiExport = require("anki-apkg-export").default;
const { getAdmin } = require("./supabaseAdmin");
const { json, readJson } = require("./http");

const MAX_CARDS = 500; // matches the cap in public/js/uploads.js: listCards()
const MAX_FIELD_CHARS = 20000; // generous; AI-written fields are far shorter, this just bounds the response size
const MAX_TAGS = 20;
const MAX_TAG_CHARS = 100;

// Plain text -> a safe Anki HTML field: escaped, with line breaks turned into <br> so they still show as breaks.
function toField(text) {
  return String(text)
    .slice(0, MAX_FIELD_CHARS)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

// A tag safe for Anki: Anki tags can't contain spaces or most punctuation, though "::" is kept so a tag like
// "Subject::Cardiology" still nests under "Subject" in Anki's own tag tree.
function toTag(text) {
  return String(text).trim().slice(0, MAX_TAG_CHARS).replace(/\s+/g, "_").replace(/[^\w:-]/g, "");
}

// POST /api/export-anki  (Authorization: Bearer <user's Supabase access token>)
// Body: { "deckName": string, "cards": [{ "front": string, "back": string, "tags": string[] }] }
// Responds with the .apkg file itself (binary), ready to save and import into Anki.
async function handleExport(req, res) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
  if (!token) return json(res, 401, { error: "Not signed in." });

  let admin;
  try {
    admin = getAdmin();
  } catch {
    return json(res, 503, { error: "Export is not configured." });
  }
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth?.user) return json(res, 401, { error: "Not signed in." });

  const body = await readJson(req, 2_000_000); // room for up to MAX_CARDS cards of AI-written text
  const cards = Array.isArray(body?.cards) ? body.cards : null;
  if (!body || !cards || !cards.length || cards.length > MAX_CARDS) {
    return json(res, 400, { error: `Send between 1 and ${MAX_CARDS} cards.` });
  }
  for (const c of cards) {
    if (typeof c?.front !== "string" || typeof c?.back !== "string" || !c.front.trim() || !c.back.trim()) {
      return json(res, 400, { error: "Every card needs a front and a back." });
    }
  }
  const deckName = typeof body.deckName === "string" && body.deckName.trim() ? body.deckName.trim().slice(0, 80) : "MedDeck";

  let zip;
  try {
    const apkg = new AnkiExport(deckName);
    for (const c of cards) {
      const tags = Array.isArray(c.tags) ? c.tags.map(toTag).filter(Boolean).slice(0, MAX_TAGS) : [];
      apkg.addCard(toField(c.front), toField(c.back), { tags });
    }
    zip = await apkg.save();
  } catch (err) {
    console.error("[export-anki]", err?.message || err);
    return json(res, 500, { error: "Couldn't build the Anki package. Please try again." });
  }

  const fileName = `${deckName.replace(/[^\w -]/g, "").trim() || "MedDeck"}.apkg`;
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Content-Length": zip.length,
  });
  res.end(zip);
}

module.exports = { handleExport };
