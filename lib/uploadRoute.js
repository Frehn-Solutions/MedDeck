// The HTTP side of card generation: checks who is calling, then starts the background worker.
const { getAdmin } = require("./supabaseAdmin");
const { processUpload, DEFAULT_CARDS, MAX_CARDS } = require("./processUpload");
const { DEFAULT_LEVEL, isLevel } = require("./levels");

// Send a JSON response with the given status code.
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// Reads a small JSON body. Returns null if it is too large or not valid JSON; an empty body is {}.
function readJson(req, limit = 1024) {
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
// Optional JSON body: { "cardCount": 1..MAX_CARDS, "level": "<id from levels.js>" }
//   cardCount = total cards wanted (default DEFAULT_CARDS), level = study level (default DEFAULT_LEVEL).
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

  // 3. Validate the requested options. They control what the AI is asked to do (and how much), so they are never trusted blindly.
  const body = await readJson(req);
  const cardCount = body?.cardCount ?? DEFAULT_CARDS;
  if (!body || !Number.isInteger(cardCount) || cardCount < 1 || cardCount > MAX_CARDS) {
    return json(res, 400, { error: `cardCount must be a whole number from 1 to ${MAX_CARDS}.` });
  }
  const level = body.level ?? DEFAULT_LEVEL;
  if (!isLevel(level)) return json(res, 400, { error: "Unknown study level." });

  // 4. Reply immediately, then run the worker without awaiting it. The browser polls uploads.status for progress.
  json(res, 202, { accepted: true, cardCount, level });
  processUpload(uploadId, { cardCount, level }).catch((err) => console.error("[process-upload]", uploadId, "unhandled", err?.name ?? ""));
}

module.exports = { handleProcess };
