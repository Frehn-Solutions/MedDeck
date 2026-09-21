// Turns one chunk of study material into flashcards by asking Claude, then checks what comes back.
// The AI's reply is treated as untrusted input: it is parsed, validated and trimmed before anything is stored.
const fs = require("node:fs");
const path = require("node:path");
const Anthropic = require("@anthropic-ai/sdk");
const { UserError } = require("./errors");
const { LEVELS, DEFAULT_LEVEL, isLevel } = require("./levels");

// Which Claude model to use; override with MEDDECK_MODEL in .env.
const MODEL = process.env.MEDDECK_MODEL || "claude-sonnet-5";
const PROMPT_FILE = path.join(__dirname, "..", "prompt.txt");

// prompt.txt is the whole system prompt: the card-writing rules AND the output format. It is re-read on
// every call, so edits apply without a restart. Placeholders written as {NAME} are filled in from `vars`.
// Current variables: {MAX_CARDS} and {LEVEL_INSTRUCTION}. To add one, give it a value in ask() below
// and use {NAME} in prompt.txt.
const warned = new Set(); // unknown placeholders already reported, so the log isn't flooded
function fillPrompt(template, vars) {
  return template.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (match, name) => {
    if (Object.hasOwn(vars, name)) return String(vars[name]);
    // Only the placeholder name is logged, never any uploaded text.
    if (!warned.has(name)) {
      warned.add(name);
      console.warn("[prompt] prompt.txt uses {" + name + "} but no value is provided for it");
    }
    return match;
  });
}
const systemPrompt = (vars) => fillPrompt(fs.readFileSync(PROMPT_FILE, "utf8").trim(), vars);

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

// One call to Claude. Returns the reply as plain text. Fills the placeholders in prompt.txt:
//   {MAX_CARDS} = how many cards this chunk may produce, {LEVEL_INSTRUCTION} = wording for the chosen study level.
async function ask(messages, count, level) {
  const system = systemPrompt({ MAX_CARDS: count, LEVEL_INSTRUCTION: LEVELS[level].instruction });
  const res = await getClient().messages.create({ model: MODEL, max_tokens: 8192, system, messages });
  if (res.stop_reason === "max_tokens") throw new MalformedError(); // truncated JSON
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

// One chunk -> up to `count` validated card rows (without upload_id / user_id). Retries once on malformed output.
// `level` is a key of LEVELS (see levels.js); anything else falls back to the default.
async function generateForChunk(chunk, count, level = DEFAULT_LEVEL) {
  if (!isLevel(level)) level = DEFAULT_LEVEL;
  // The chunk text goes inside <material> tags so the model can tell instructions from data.
  const prompt = { role: "user", content: `Study material (${chunk.label}):\n<material>\n${chunk.text}\n</material>` };
  const retryNote = {
    role: "user",
    content: "That reply was not valid JSON in the required shape. Return ONLY the JSON array, and keep it shorter.",
  };

  try {
    let reply;
    try {
      // First attempt. topCards() enforces the limit even if the model writes too many cards.
      reply = await ask([prompt], count, level);
      return topCards(validate(parseReply(reply), chunk.label), count);
    } catch (err) {
      if (!(err instanceof MalformedError)) throw err;
      // Second (and last) attempt: show the model its own bad reply and ask again.
      const history = reply ? [prompt, { role: "assistant", content: reply }, retryNote] : [prompt, retryNote];
      return topCards(validate(parseReply(await ask(history, count, level)), chunk.label), count);
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
