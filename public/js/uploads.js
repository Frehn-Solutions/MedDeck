// Talking to the database and the server about uploads and the cards generated from them.
import { supabase } from "./supabaseClient.js";

// Rows in `uploads` and `cards` are readable by their owner through RLS.

// Record a file that was just uploaded to Storage. status defaults to 'uploaded' and user_id to the
// signed-in user, both set by the database. Returns the new row's id.
export async function createUpload({ fileName, fileType, fileSize, storagePath }) {
  const { data, error } = await supabase
    .from("uploads")
    .insert({ file_name: fileName, file_type: fileType, file_size: fileSize, storage_path: storagePath })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// Asks the server to start generating cards. Returns straight away; progress shows in uploads.status.
// The user's access token proves who is asking; the server checks it and that the upload is theirs.
// `settings` is { cardCount, focus, difficulty, yearGroup, context }; see the notes on handleProcess in lib/uploadRoute.js.
export async function startProcessing(uploadId, settings) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("You're signed out. Please log in again.");

  const res = await fetch(`/api/uploads/${encodeURIComponent(uploadId)}/process`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(settings), // the server validates every field
  });
  // 202 Accepted means the worker was started (or was already running).
  if (res.status !== 202) {
    // The server explains a refused free-trial request; `code` lets the page show the login prompt.
    const body = await res.json().catch(() => ({}));
    const err = new Error(res.status === 403 && body.error ? body.error : "Couldn't start processing. Please try again.");
    err.code = body.code;
    throw err;
  }
}

// Remove an upload row (RLS lets users delete only their own). Used for files that are still waiting to be
// generated. Like deleteCard, it checks that a row really was deleted. The caller removes the stored file.
export async function deleteUpload(uploadId) {
  const { data, error } = await supabase.from("uploads").delete().eq("id", uploadId).select("id");
  if (error) throw error;
  if (!data.length) throw new Error("That upload couldn't be removed. It may already be gone.");
}

// The user's most recent uploads with their status. Polled while any are still being processed.
// storage_path is included so a waiting file can be removed from Storage as well.
export async function listUploads() {
  const { data, error } = await supabase
    .from("uploads")
    .select("id, file_name, status, error, created_at, storage_path")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

// Delete one card. RLS only lets users delete their own, and a blocked delete removes zero rows without
// raising an error, so the returned rows are checked to make sure something was actually deleted.
export async function deleteCard(cardId) {
  const { data, error } = await supabase.from("cards").delete().eq("id", cardId).select("id");
  if (error) throw error;
  if (!data.length) throw new Error("That card couldn't be deleted. It may already be gone.");
}

// The user's generated cards, newest first. `uploads(file_name)` joins in the name of the source file.
export async function listCards() {
  const { data, error } = await supabase
    .from("cards")
    .select("id, card_type, content, created_at, uploads(file_name)")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return data;
}
