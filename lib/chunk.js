// Splitting extracted text into request-sized chunks, and dividing the requested card count between them.
// Big files (a 200-slide deck) can't go to the AI in one request, so they are cut into pieces first.

// Rough upper size of one chunk, in characters (about 2,000 tokens of input per request).
const MAX_CHARS = 8000;

// Break a single unit that is longer than max into paragraph-aligned pieces.
// A "unit" is one page, slide or section; most are small, but a huge section has to be cut somewhere.
function splitLarge(unit, max) {
  if (unit.text.length <= max) return [unit];

  // First cut on blank lines (paragraphs); a single paragraph longer than max is sliced by length.
  const pieces = [];
  for (const para of unit.text.split(/\n{2,}/)) {
    for (let i = 0; i < para.length; i += max) pieces.push(para.slice(i, i + max));
  }

  // Then glue pieces back together, starting a new part whenever adding one would exceed max.
  const out = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > max) {
      out.push({ ...unit, text: current });
      current = "";
    }
    current += (current ? "\n\n" : "") + piece;
  }
  if (current) out.push({ ...unit, text: current });
  return out;
}

// A human-readable name for a chunk, stored on each card so users can see where it came from.
// PDF units carry page numbers ("Pages 3-5"); text units use their heading ("Intro - Methods").
function labelFor(units) {
  const first = units[0];
  const last = units[units.length - 1];
  if (first.page && last.page) {
    return first.page === last.page ? `Page ${first.page}` : `Pages ${first.page}-${last.page}`;
  }
  return first.label === last.label ? first.label : `${first.label} - ${last.label}`;
}

// Group units (pages, slides, sections) into chunks of roughly max characters without splitting a unit.
function chunkUnits(units, max = MAX_CHARS) {
  const chunks = [];
  let current = [];
  let length = 0;

  // Close the chunk being built and start a new empty one.
  const flush = () => {
    if (!current.length) return;
    // PDF pages get a "[Page N]" marker so the AI can say which page a fact came from (material_reference).
    const text = current.map((u) => (u.page ? `[Page ${u.page}]\n${u.text}` : u.text)).join("\n\n");
    chunks.push({ label: labelFor(current), text });
    current = [];
    length = 0;
  };

  for (const unit of units.flatMap((u) => splitLarge(u, max))) {
    if (length + unit.text.length > max) flush();
    current.push(unit);
    length += unit.text.length + 2; // +2 for the blank line added between units
  }
  flush();
  return chunks;
}

// Split a total card count across chunks in proportion to their length (largest-remainder method),
// so the counts always sum to `total`. When total < chunks, the longest chunks get the cards.
function allocateCards(chunks, total) {
  // Each chunk's ideal (fractional) share, e.g. 3.6 cards.
  const size = chunks.reduce((n, c) => n + c.text.length, 0);
  const exact = chunks.map((c) => (total * c.text.length) / size);
  // Start with the whole-number part of every share...
  const counts = exact.map(Math.floor);
  let left = total - counts.reduce((a, b) => a + b, 0);
  // ...then hand out the leftover cards to the chunks with the biggest fractional parts (longer chunk wins ties).
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x), len: chunks[i].text.length }))
    .sort((a, b) => b.frac - a.frac || b.len - a.len);
  for (const { i } of order) {
    if (left-- <= 0) break;
    counts[i]++;
  }
  return counts;
}

module.exports = { chunkUnits, allocateCards };
