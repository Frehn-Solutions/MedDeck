// Browser-side helpers for putting study files into Supabase Storage, and the rules for which files are allowed.
import { supabase } from "./supabaseClient.js";

const BUCKET = "study-materials"; // private bucket created by supabase/storage.sql
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB, the same limit the bucket enforces

// The file types the server can turn into cards (see lib/extract.js): extension -> MIME type.
// The type is sent explicitly because browsers leave it blank for some files (e.g. .md), and the bucket
// rejects types that aren't on its allow-list (supabase/storage.sql, which also lists types for future support).
const TYPES = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
};

// MIME type for a file name, or undefined if that kind of file isn't supported.
// hasOwn stops names like "constructor" from matching inherited object properties.
export const typeOf = (name) => {
  const ext = name.split(".").pop().toLowerCase();
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : undefined;
};

// Quick checks before uploading. Returns a message describing the problem, or null if the file is fine.
export function validate(file) {
  if (!typeOf(file.name)) return "Only PDF, text and Markdown files are supported for now.";
  if (file.size === 0) return "File is empty.";
  if (file.size > MAX_BYTES) return `Too large (max ${MAX_BYTES / 1024 / 1024} MB).`;
  return null;
}

// Storage keys reject many characters, so keep a conservative set.
// e.g. "Cardio notes (v2).pdf" becomes "Cardio_notes_v2_.pdf".
const safeName = (name) => name.replace(/[^A-Za-z0-9._-]+/g, "_");

// Upload into the user's own folder (<user id>/<timestamp>-<name>); the bucket's rules only allow that folder.
// The timestamp keeps two files with the same name from colliding. Returns the object's storage path.
export async function uploadMaterial(userId, file) {
  const path = `${userId}/${Date.now()}-${safeName(file.name)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: typeOf(file.name), upsert: false });
  if (error) throw error;
  return path;
}

// Used when the upload succeeded but recording it did not, so no orphan is left behind.
export async function discardMaterial(path) {
  await supabase.storage.from(BUCKET).remove([path]);
}
