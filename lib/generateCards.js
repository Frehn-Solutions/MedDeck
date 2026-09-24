// Turns one chunk of study material into flashcards by asking Claude, then checks what comes back.
// The AI's reply is treated as untrusted input: it is parsed, validated and trimmed before anything is stored.
const Anthropic = require("@anthropic-ai/sdk");
const { UserError } = require("./errors");
const { buildSystemPrompt, contextBlock, SUBJECTS, ASPECTS, CARD_DIFFICULTIES } = require("./prompts");

// Which Claude model to use; override with MEDDECK_MODEL in .env.
const MODEL = process.env.MEDDECK_MODEL || "claude-sonnet-5";

// At most this many AI requests run at once across ALL uploads. Each upload already sends a few chunks in
// parallel (see processUpload.js), so without this limit several files generated together could flood the API
// and trigger its rate limits. Extra requests simply wait their turn.
const MAX_AI_REQUESTS = 6;
let activeRequests = 0;
const waiting = []; // resolve functions of requests waiting for a free slot, in arrival order
async function withSlot(fn) {
  if (activeRequests < MAX_AI_REQUESTS) activeRequests++;
  else await new Promise((resolve) => waiting.push(resolve)); // the slot is handed over by whoever finishes next
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next(); // pass our slot straight to the next in line (activeRequests stays the same)
    else activeRequests--;
  }
}

// The Anthropic client reads ANTHROPIC_API_KEY from the environment. Created once, on first use.
let client;
const getClient = () => (client ||= new Anthropic());

// Thrown internally when the AI's reply can't be used (bad JSON, wrong shape, cut off). Triggers one retry.
class MalformedError extends Error {}

// Trimmed string if it is non-empty and no longer than max characters, otherwise null.
const clean = (value, max) => {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s && s.length <= max ? s : null;
};

const JSON_PARSE_FAILED = Symbol("parse failed");
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON_PARSE_FAILED;
  }
}

// Get the array of cards out of the model's reply. The prompt asks for a JSON array; a { "cards": [...] }
// wrapper is accepted too. Code fences or stray text around the JSON are tolerated.
function parseReply(reply) {
  const unfenced = reply.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let data = tryParse(unfenced);
  if (data === JSON_PARSE_FAILED) {
    // Fall back to the outermost [ ... ] in the reply.
    const start = unfenced.indexOf("[");
    const end = unfenced.lastIndexOf("]");
    if (start === -1 || end < start) throw new MalformedError();
    data = tryParse(unfenced.slice(start, end + 1));
  }
  if (data && !Array.isArray(data) && Array.isArray(data.cards)) data = data.cards;
  if (!Array.isArray(data)) throw new MalformedError();
  return data;
}

// The model may write "null" or "N/A" as text when it has no guideline; treat those as no guideline.
const NO_GUIDELINE = /^(null|none|n\/?a|nil|-+)$/i;

// The card labels (see prompts.js). A subject is matched ignoring case to its official spelling, so cards group
// consistently; anything unrecognised becomes "Other". Difficulty and aspect are null when missing or unrecognised,
// and the page then simply shows no such label.
const SUBJECT_BY_LOWER = new Map(SUBJECTS.map((s) => [s.toLowerCase(), s]));
const cleanSubject = (value) => SUBJECT_BY_LOWER.get(typeof value === "string" ? value.trim().toLowerCase() : "") ?? "Other";
const cleanChoice = (value, allowed) => {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.includes(v) ? v : null;
};
// Topics are short free text. Spaces are tidied and the first letter is capitalised so "heart failure" and
// "Heart failure" end up as the same group.
const cleanTopic = (value) => {
  const t = clean(typeof value === "string" ? value.replace(/\s+/g, " ") : value, 60);
  return t ? t[0].toUpperCase() + t.slice(1) : null;
};

// Keeps valid cards, drops invalid ones. Throws if cards came back but none were usable.
// Returns rows shaped for the `cards` table (upload_id and user_id are added later by processUpload).
function validate(items, location) {
  const cards = [];
  for (const c of items) {
    // A card needs at least a question and an answer; everything else is optional.
    const front = clean(c?.front, 1000);
    const back = clean(c?.back, 2000);
    if (!front || !back) continue;

    const guideline = clean(c.guideline, 300);
    const tags = Array.isArray(c.tags) ? c.tags.map((t) => clean(t, 40)).filter(Boolean).slice(0, 8) : [];
    const priority = Number(c.priority); // 1 = core, 2 = useful, 3 = extra detail
    cards.push({
      card_type: "anki",
      content: {
        front,
        back,
        reasoning: clean(c.reasoning, 2000),
        material_reference: clean(c.material_reference, 200), // slide / page / section, as the model saw it
        guideline: guideline && !NO_GUIDELINE.test(guideline) ? guideline : null,
        priority: Number.isInteger(priority) && priority >= 1 && priority <= 3 ? priority : null,
        difficulty: cleanChoice(c.difficulty, CARD_DIFFICULTIES),
        subject: cleanSubject(c.subject),
        topic: cleanTopic(c.topic),
        aspect: cleanChoice(c.aspect, ASPECTS),
        tags,
        location, // our own label for the chunk (e.g. "Pages 3-5"), used when the model gives no reference
      },
    });
  }
  // Items existed but none passed: treat as a bad reply (so it gets retried) rather than silently returning nothing.
  if (cards.length === 0 && items.length > 0) throw new MalformedError();
  return cards;
}

// If the model wrote more cards than allowed, keep the most important ones: lowest priority number first
// (a missing priority counts as 2). The sort is stable, so cards otherwise stay in the order written.
const topCards = (cards, count) => cards.sort((a, b) => (a.content.priority ?? 2) - (b.content.priority ?? 2)).slice(0, count);

// One call to Claude. Returns the reply as plain text.
// The system prompt comes from prompts.js (fixed text chosen by the settings + card limit); the study material and
// the student's context are only ever in `messages`.
async function ask(messages, count, settings) {
  const system = buildSystemPrompt(settings, count);
  const res = await withSlot(() => getClient().messages.create({ model: MODEL, max_tokens: 8192, system, messages }));
  if (res.stop_reason === "max_tokens") throw new MalformedError(); // truncated JSON
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

// One chunk -> up to `count` validated card rows (without upload_id / user_id). Retries once on malformed output.
// `settings` is { focus, difficulty, yearGroup, context }. buildSystemPrompt() validates focus, difficulty and year
// group (falling back to defaults). `context` is the student's optional free text (see prompts.js); it is sent with
// the material, never in the system prompt.
async function generateForChunk(chunk, count, settings = {}) {
  // The chunk text goes inside <material> tags so the model can tell instructions from data.
  const prompt = {
    role: "user",
    content: `${contextBlock(settings.context)}Study material (${chunk.label}):\n<material>\n${chunk.text}\n</material>`,
  };
  const retryNote = {
    role: "user",
    content: "That reply was not valid JSON in the required shape. Return ONLY the JSON array, and keep it shorter.",
  };

  try {
    let reply;
    try {
      // First attempt. topCards() enforces the limit even if the model writes too many cards.
      reply = await ask([prompt], count, settings);
      return topCards(validate(parseReply(reply), chunk.label), count);
    } catch (err) {
      if (!(err instanceof MalformedError)) throw err;
      // Second (and last) attempt: show the model its own bad reply and ask again.
      const history = reply ? [prompt, { role: "assistant", content: reply }, retryNote] : [prompt, retryNote];
      return topCards(validate(parseReply(await ask(history, count, settings)), chunk.label), count);
    }
  } catch (err) {
    // Translate low-level failures into short messages that are safe to show the user.
    if (err instanceof MalformedError) throw new UserError("The AI returned an unreadable response. Please try again.");
    if (err instanceof Anthropic.APIError) {
      const e = new UserError("The AI service is unavailable right now. Please try again shortly.");
      e.status = err.status; // logged by the caller; never the message
      throw e;
    }
    throw err;
  }
}

module.exports = { generateForChunk };
