const { PDFParse } = require("pdf-parse");
const { UserError } = require("./errors");

// Reads the text out of an uploaded file (PDF, plain text or Markdown).
// Returns the file's text as units ({ text, label, page? }) that chunk.js groups into requests.
// Problems the user can act on are thrown as UserErrors, so their message is shown on the upload.

// Decide how to read the file: "pdf" or "text". The file extension is checked first, then the MIME type.
// Known-but-unsupported formats get a specific message; anything else gets a generic one.
function kindOf(fileName, fileType) {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (ext === "pdf" || fileType === "application/pdf") return "pdf";
  if (ext === "txt" || ext === "md" || fileType === "text/plain" || fileType === "text/markdown") return "text";
  if (ext === "pptx" || ext === "ppt") throw new UserError("PowerPoint files aren't supported yet.");
  if (ext === "docx" || ext === "doc") throw new UserError("Word files aren't supported yet.");
  throw new UserError("This file type isn't supported yet.");
}

// PDFs: one unit per page, so cards can say which page they came from.
async function extractPdf(buffer) {
  // Every real PDF starts with "%PDF-"; this catches files that were just renamed to .pdf.
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") throw new UserError("This file isn't a valid PDF.");

  let pages;
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    pages = (await parser.getText()).pages;
  } catch {
    throw new UserError("We couldn't read this PDF. It may be damaged or password-protected.");
  } finally {
    // Always release the parser's memory, even if reading failed.
    await parser.destroy().catch(() => {});
  }

  // Drop empty pages, then count the real characters. Scanned PDFs are just images, so they yield
  // (almost) no text; those would need OCR, which isn't supported yet, so we say so instead of making empty cards.
  const units = pages.map((p) => ({ text: p.text.trim(), label: `Page ${p.num}`, page: p.num })).filter((u) => u.text);
  const chars = units.reduce((n, u) => n + u.text.replace(/\s/g, "").length, 0);
  if (chars < Math.max(100, pages.length * 20)) {
    throw new UserError("This looks like a scanned PDF, which isn't supported yet.");
  }
  return units;
}

// Plain text and Markdown are read directly.
function extractText(buffer) {
  // A NUL byte means binary data, i.e. not really a text file.
  if (buffer.includes(0)) throw new UserError("This doesn't look like a text file.");
  const text = buffer.toString("utf8").replace(/^﻿/, "").trim();
  if (!text) throw new UserError("This file is empty.");

  // Split Markdown on headings; plain text falls through as a single unit that chunk.js splits by paragraph.
  const sections = text.split(/^(?=#{1,6}\s)/m).map((s) => s.trim()).filter(Boolean);
  return sections.map((s, i) => {
    // The heading text becomes the section's label; sections without one are numbered.
    const heading = /^#{1,6}\s+(.+)/.exec(s);
    return { text: s, label: heading ? heading[1].slice(0, 80) : `Section ${i + 1}` };
  });
}

// Entry point used by processUpload: picks the right reader for the file.
async function extractUnits(buffer, fileName, fileType) {
  return kindOf(fileName, fileType) === "pdf" ? extractPdf(buffer) : extractText(buffer);
}

module.exports = { extractUnits };
