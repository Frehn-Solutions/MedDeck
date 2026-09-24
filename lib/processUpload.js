// The background worker: takes one uploaded file and turns it into flashcards.
// Steps: claim the job -> check the file path -> download -> extract text -> chunk -> ask Claude -> save cards -> delete the file.
// Nothing about the file's contents is ever logged, and the file itself is deleted when we're done (no retention).
const { getAdmin } = require("./supabaseAdmin");
const { UserError } = require("./errors");
const { extractUnits } = require("./extract");
const { chunkUnits, allocateCards } = require("./chunk");
const { generateForChunk } = require("./generateCards");
const { normaliseFocus, normaliseDifficulty, normaliseYearGroup, normaliseContext } = require("./prompts");

const BUCKET = "study-materials"; // Supabase Storage bucket the browser uploads into
const MAX_CHUNKS = 40; // caps AI spend per upload (~320k characters)
const DEFAULT_CARDS = 10; // used when the caller doesn't say how many cards it wants
const MAX_CARDS = 50; // upper bound on cards per upload
const MAX_CARDS_PER_CHUNK = 40; // hard ceiling on the {MAX_CARDS} any single request may ask the AI for
const CONCURRENCY = 3; // how many chunks are sent to the AI at the same time
const INSERT_BATCH = 500; // cards inserted per database request
const GENERIC_ERROR = "Processing failed unexpectedly. Please try again."; // shown for errors we don't explain

// Logging rule: only ids, stages and error classes. Never file contents, and never err.message
// for non-UserErrors, because library messages (e.g. JSON.parse) can quote the text.
const log = (id, stage, err) =>
  console.error("[process-upload]", id, stage, err?.name ?? "", err?.status ?? err?.code ?? "");

// Runs fn over items with at most `limit` running at once, keeping results in the original order.
// If one item fails, no new items are started and the error is passed on.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0; // index of the next item to start (shared by all workers)
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// storage_path is user-controlled (users can insert their own rows), so it must sit in the owner's folder.
// Without this check someone could point their row at another user's file and have it read or deleted.
function assertOwnPath(upload) {
  const { storage_path: p, user_id: uid } = upload;
  const ok = typeof p === "string" && p.startsWith(`${uid}/`) && p.length > uid.length + 1 && !p.split("/").includes("..");
  if (!ok) throw new UserError("Invalid file location.");
}

// Delete the uploaded file from storage. A failure is logged but doesn't change the upload's outcome.
async function removeFile(id, path) {
  const { error } = await getAdmin().storage.from(BUCKET).remove([path]);
  if (error) log(id, "delete-file", error);
}

/**
 * Processes one upload end to end. Safe to call more than once for the same id:
 * only the call that flips the row from 'uploaded' to 'processing' does any work.
 * `cardCount` is the total number of cards wanted for the whole file, shared out between the file's chunks in
 * proportion to their length. The rest are the student's settings (see prompts.js): `focus` ("clinical" or
 * "preclinical"), `difficulty` ("easy", "medium" or "difficult"), `yearGroup` ({ course, year } or null) and the
 * optional free-text `context`. They are passed to the AI and not stored.
 * Resolves with { claimed, status } and never throws for per-file problems.
 */
async function processUpload(uploadId, { cardCount = DEFAULT_CARDS, focus, difficulty, yearGroup, context } = {}) {
  const admin = getAdmin();
  // Callers should already have validated these; this makes the worker safe on its own.
  const settings = {
    focus: normaliseFocus(focus),
    difficulty: normaliseDifficulty(difficulty),
    yearGroup: normaliseYearGroup(yearGroup),
    context: normaliseContext(context),
  };
  // Clamp to a sane whole number even if a caller passes something odd.
  const total = Math.min(Math.max(Math.trunc(cardCount) || DEFAULT_CARDS, 1), MAX_CARDS);

  // 1. Atomic claim: a single UPDATE ... WHERE status = 'uploaded'. If no row changed, someone else has it.
  // This is what stops a double-click or retry from processing the same file twice.
  const { data: claimed, error: claimError } = await admin
    .from("uploads")
    .update({ status: "processing", error: null })
    .eq("id", uploadId)
    .eq("status", "uploaded")
    .select("id, user_id, file_name, file_type, storage_path");
  if (claimError) {
    log(uploadId, "claim", claimError);
    return { claimed: false };
  }
  if (!claimed?.length) return { claimed: false };
  const upload = claimed[0];

  // State the failure handler below needs to know about.
  let stage = "path-check"; // which step we're in, for logging
  let fileIsOurs = false; // only delete files whose path passed the ownership check
  let cardsInserted = false; // so a late failure can remove cards that were already saved
  try {
    // 2. Path check
    assertOwnPath(upload);
    fileIsOurs = true;

    // 3. Download
    stage = "download";
    const { data: blob, error: downloadError } = await admin.storage.from(BUCKET).download(upload.storage_path);
    if (downloadError || !blob) throw new UserError("We couldn't read the uploaded file.");
    const buffer = Buffer.from(await blob.arrayBuffer());

    // 4-5. Extract and chunk
    stage = "extract";
    const chunks = chunkUnits(await extractUnits(buffer, upload.file_name, upload.file_type));
    if (chunks.length > MAX_CHUNKS) throw new UserError("This file is too long to process. Try splitting it up.");

    // 6. Generate (nothing is written until every chunk has succeeded)
    // Split the requested card total across chunks in proportion to their length (this is each request's
    // {MAX_CARDS}), never more than the per-chunk ceiling, skip any that get zero, and run a few at a time.
    stage = "generate";
    const counts = allocateCards(chunks, total).map((n) => Math.min(n, MAX_CARDS_PER_CHUNK));
    const jobs = chunks.map((chunk, i) => ({ chunk, count: counts[i] })).filter((j) => j.count > 0);
    const perChunk = await mapPool(jobs, CONCURRENCY, (j) => generateForChunk(j.chunk, j.count, settings));
    const rows = perChunk.flat().map((card) => ({ ...card, upload_id: upload.id, user_id: upload.user_id }));
    if (!rows.length) throw new UserError("No study cards could be generated from this file.");

    // 7. Insert cards with user_id set explicitly (no auth.uid() with the service key)
    stage = "insert-cards";
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const { error } = await admin.from("cards").insert(rows.slice(i, i + INSERT_BATCH));
      cardsInserted = true;
      if (error) throw error;
    }

    // 8. Done, then delete the file
    // The status change is conditional on still being 'processing', so it can't overwrite anything else.
    stage = "mark-done";
    const { error: doneError } = await admin
      .from("uploads")
      .update({ status: "done", error: null })
      .eq("id", upload.id)
      .eq("status", "processing");
    if (doneError) throw doneError;

    await removeFile(upload.id, upload.storage_path);
    return { claimed: true, status: "done", cards: rows.length };
  } catch (err) {
    // Any failure lands here: record a short, safe message, undo partial work and clean up the file.
    log(upload.id, stage, err);
    const message = err instanceof UserError ? err.message : GENERIC_ERROR;

    // If cards were already saved, remove them so a failed upload never leaves a partial set behind.
    if (cardsInserted) {
      const { error } = await admin.from("cards").delete().eq("upload_id", upload.id);
      if (error) log(upload.id, "rollback-cards", error);
    }
    const { error: failError } = await admin
      .from("uploads")
      .update({ status: "failed", error: message })
      .eq("id", upload.id);
    if (failError) log(upload.id, "mark-failed", failError);
    // Never delete a file whose path failed the ownership check: it might belong to someone else.
    if (fileIsOurs) await removeFile(upload.id, upload.storage_path);

    return { claimed: true, status: "failed" };
  }
}

module.exports = { processUpload, DEFAULT_CARDS, MAX_CARDS };
