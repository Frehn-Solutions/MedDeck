// The HTTP side of card generation: checks who is calling, then starts the background worker.
const { getAdmin } = require("./supabaseAdmin");
const { processUpload, DEFAULT_CARDS, MAX_CARDS } = require("./processUpload");
const { normaliseFocus, normaliseDifficulty, normaliseYearGroup, normaliseContext } = require("./prompts");

// Send a JSON response with the given status code.
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// Reads a small JSON body. Returns null if it is too large or not valid JSON; an empty body is {}.
function readJson(req, limit = 8192) { // room for the optional context (up to 1,000 characters, some escaped)
  return new Promise((resolve) => {
    let raw = "";
    // Accumulate the body, but give up (and drop the connection) if it grows past the limit.
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        resolve(null);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

// POST /api/uploads/:id/process  (Authorization: Bearer <user's Supabase access token>)
// Optional JSON body: { "cardCount": 1..MAX_CARDS, "focus": "clinical" | "preclinical",
//   "difficulty": "easy" | "medium" | "difficult", "yearGroup": { "course": "undergraduate" | "gem", "year": 1..5 or 1..4 },
//   "context": "free text" }
//   cardCount = total cards wanted (default DEFAULT_CARDS); focus = what kind of cards to favour (default "clinical");
//   difficulty (default "medium") and yearGroup (default none) tune the level; context = the student's optional notes
//   for the AI. Each is checked by the normalise functions in prompts.js, so invalid values fall back to the default.
//   Only focus is stored; the rest are used for this generation only.
// Returns 202 straight away; processing continues in the background. Clients watch uploads.status.
async function handleProcess(req, res, uploadId) {
  // 1. Who is calling? The identity comes only from the access token, never from anything in the request body.
  const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1];
  if (!token) return json(res, 401, { error: "Not signed in." });

  let admin;
  try {
    admin = getAdmin();
  } catch {
    return json(res, 503, { error: "Processing is not configured." });
  }

  // The endpoint spends AI credits, so only the upload's owner may trigger it.
  // Supabase verifies the token's signature and expiry and tells us which user it belongs to.
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth?.user) return json(res, 401, { error: "Not signed in." });

  // 2. Does the upload belong to that user? Both "missing" and "someone else's" answer 404,
  // so the response doesn't reveal which upload ids exist.
  const { data: upload } = await admin.from("uploads").select("user_id").eq("id", uploadId).maybeSingle();
  if (!upload || upload.user_id !== auth.user.id) return json(res, 404, { error: "Upload not found." });

  // Visitors without an account (anonymous Supabase users) get one free generation. This is enforced here because the
  // browser can't be trusted. They may only start their earliest waiting upload, and only while none of their
  // uploads has already been started or finished. (A failed upload doesn't use up the free generation.)
  if (auth.user.is_anonymous) {
    const { data: mine, error: mineError } = await admin
      .from("uploads")
      .select("id, status")
      .eq("user_id", auth.user.id)
      .in("status", ["uploaded", "processing", "done"])
      .order("created_at", { ascending: true });
    if (mineError) {
      console.error("[process-upload]", uploadId, "free-check", mineError.code ?? "");
      return json(res, 500, { error: "Couldn't start processing. Please try again." });
    }
    const allowed = mine[0]?.id === uploadId && mine.every((u) => u.id === uploadId || u.status === "uploaded");
    if (!allowed) {
      return json(res, 403, { code: "free_limit", error: "Your free generation has been used. Log in or sign up to make more cards." });
    }
  }

  // 3. Validate the requested options. They control what the AI is asked to do (and how much), so they are never trusted blindly.
  const body = await readJson(req);
  const cardCount = body?.cardCount ?? DEFAULT_CARDS;
  if (!body || !Number.isInteger(cardCount) || cardCount < 1 || cardCount > MAX_CARDS) {
    return json(res, 400, { error: `cardCount must be a whole number from 1 to ${MAX_CARDS}.` });
  }
  // Focus is checked against the two allowed words; anything else (missing, wrong type, junk) becomes "clinical".
  // From here on only this validated value is used, never body.focus itself.
  const focus = normaliseFocus(body.focus);
  const difficulty = normaliseDifficulty(body.difficulty); // "medium" unless it is exactly "easy" or "difficult"
  const yearGroup = normaliseYearGroup(body.yearGroup); // null unless it is a real course with a year in range
  const context = normaliseContext(body.context); // "" if missing or not a string; otherwise cleaned and capped

  // Record the focus on the upload row. It only applies while the upload is still waiting ('uploaded'), so a
  // repeat call can't change the focus of a file that is already being processed or finished.
  const { error: focusError } = await admin.from("uploads").update({ focus }).eq("id", uploadId).eq("status", "uploaded");
  if (focusError) {
    console.error("[process-upload]", uploadId, "save-focus", focusError.code ?? "");
    return json(res, 500, { error: "Couldn't save the upload settings." });
  }

  // 4. Reply immediately, then run the worker without awaiting it. The browser polls uploads.status for progress.
  json(res, 202, { accepted: true, cardCount, focus });
  processUpload(uploadId, { cardCount, focus, difficulty, yearGroup, context }).catch((err) => console.error("[process-upload]", uploadId, "unhandled", err?.name ?? ""));
}

module.exports = { handleProcess };
