// Logic for portal.html, the study-materials portal. The page flow is:
//   drop a file -> upload to Storage -> record it in `uploads` -> ask the server to generate cards
//   -> poll the upload's status until it's done -> show the generated cards.
import { isConfigured, supabase } from "./supabaseClient.js";
import { discardMaterial, typeOf, uploadMaterial, validate } from "./storage.js";
import { createUpload, deleteCard, listCards, listUploads, startProcessing } from "./uploads.js";

document.getElementById("year").textContent = new Date().getFullYear(); // footer copyright year

// Page elements, looked up once.
const drop = document.getElementById("drop"); // the drag-and-drop area (also a <label> for the file input)
const input = document.getElementById("file");
const queue = document.getElementById("queue"); // per-file progress while uploading
const uploadsEl = document.getElementById("uploads"); // list of the user's uploads and their status
const uploadsStatus = document.getElementById("uploads-status");
const cardsEl = document.getElementById("cards"); // list of generated cards
const cardsStatus = document.getElementById("cards-status");
const cardsHeading = document.getElementById("cards-heading");
const errorEl = document.getElementById("error");
const countInput = document.getElementById("count"); // "Cards to generate" number field
const levelSelect = document.getElementById("level"); // "Study level" dropdown

const MIN_CARDS = 1;
const MAX_CARDS = 50; // keep in step with lib/processUpload.js

const POLL_MS = 2500; // how often to re-check upload status while something is processing
const PRIORITY_TEXT = ["core knowledge", "useful", "extra detail"]; // meaning of a card's priority 1, 2, 3
const STATUS_TEXT = { uploaded: "Waiting to start", processing: "Generating cards…", done: "Done" };

let userId = null; // set once we know who is signed in
let pollTimer = null; // handle for the pending status poll, so it can be cancelled
let lastStatuses = new Map(); // upload id -> status at the previous poll, used to spot newly finished uploads

// Small helper: create an element with an optional CSS class and text.
// Text is set with textContent (never innerHTML), so file names and AI-written cards can't inject markup.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- Card count ----

// The chosen card count as a whole number within limits (10 if the field is empty or invalid).
function readCount() {
  const n = Math.trunc(Number(countInput.value));
  return Number.isFinite(n) ? Math.min(Math.max(n, MIN_CARDS), MAX_CARDS) : 10;
}

// Put a (clamped) value in the field and remember it for next visit.
function setCount(n) {
  countInput.value = Math.min(Math.max(n, MIN_CARDS), MAX_CARDS);
  try {
    localStorage.setItem("meddeck.cardCount", countInput.value);
  } catch {
    // Storage can be unavailable (private windows); the control still works.
  }
}

// Restore the last-used count, then wire up the - / + buttons and typed input.
try {
  const saved = Number(localStorage.getItem("meddeck.cardCount"));
  if (saved) setCount(saved);
} catch {
  // ignore
}
document.getElementById("count-down").addEventListener("click", () => setCount(readCount() - 1));
document.getElementById("count-up").addEventListener("click", () => setCount(readCount() + 1));
countInput.addEventListener("change", () => setCount(readCount())); // clamps typed values

// ---- Study level ----

// The server publishes the available levels in /config.js, so this list never drifts from lib/levels.js.
const { levels = [], defaultLevel } = window.MEDDECK_CONFIG || {};
for (const level of levels) {
  const option = el("option", "", level.label);
  option.value = level.id;
  levelSelect.append(option);
}
try {
  // Restore the last choice if it still exists; otherwise use the server's default.
  const saved = localStorage.getItem("meddeck.level");
  levelSelect.value = levels.some((l) => l.id === saved) ? saved : defaultLevel ?? "";
} catch {
  levelSelect.value = defaultLevel ?? "";
}
levelSelect.addEventListener("change", () => {
  try {
    localStorage.setItem("meddeck.level", levelSelect.value);
  } catch {
    // ignore: the choice just isn't remembered
  }
});

// The chosen level's id, or undefined if there are no levels (the server then uses its default).
const readLevel = () => levelSelect.value || undefined;

// Show (or clear, with empty text) the red error line above the lists.
function showError(text) {
  errorEl.textContent = text || "";
  errorEl.hidden = !text;
}

// ---- Uploads list ----

// Draw the "Your uploads" list: file name, date, a status badge, and a Start button for stuck uploads.
function renderUploads(rows) {
  uploadsEl.replaceChildren();
  uploadsStatus.hidden = rows.length > 0;
  uploadsStatus.textContent = "You haven't uploaded anything yet.";

  for (const row of rows) {
    const li = el("li");
    li.dataset.status = row.status; // CSS colours the badge based on this

    const info = el("div", "file-info");
    info.append(el("span", "file-name", row.file_name), el("span", "file-meta", new Date(row.created_at).toLocaleString()));

    const state = el("div", "file-state");
    state.append(el("span", "badge", row.status === "failed" ? "Failed" : STATUS_TEXT[row.status] || row.status));
    if (row.status === "processing") state.firstChild.classList.add("busy"); // shows the spinner
    if (row.status === "failed" && row.error) state.append(el("span", "file-error", row.error));
    // An upload still 'uploaded' means processing never started (e.g. the network dropped): offer a retry.
    if (row.status === "uploaded") {
      const start = el("button", "link-btn", "Start");
      start.type = "button";
      start.addEventListener("click", async () => {
        start.disabled = true;
        showError("");
        try {
          await startProcessing(row.id, readCount(), readLevel());
        } catch (err) {
          showError(err.message);
        }
        refreshUploads();
      });
      state.append(start);
    }

    li.append(info, state);
    uploadsEl.append(li);
  }
}

// Load the uploads, redraw the list, and keep polling while any upload is still in progress.
async function refreshUploads() {
  clearTimeout(pollTimer); // never run two polling loops at once
  let rows;
  try {
    rows = await listUploads();
  } catch (err) {
    uploadsStatus.hidden = true;
    showError(err.message || "Could not load your uploads.");
    return;
  }
  renderUploads(rows);

  // A row that just finished means new cards are available.
  const justFinished = rows.some((r) => r.status === "done" && lastStatuses.get(r.id) !== "done" && lastStatuses.has(r.id));
  lastStatuses = new Map(rows.map((r) => [r.id, r.status]));
  if (justFinished) refreshCards();

  if (rows.some((r) => r.status === "uploaded" || r.status === "processing")) {
    pollTimer = setTimeout(refreshUploads, POLL_MS);
  }
}

// ---- Cards list ----

// Update the "Your cards (n)" heading and the empty-state text to match what is currently listed.
function syncCardsHeader() {
  const n = cardsEl.children.length;
  cardsHeading.textContent = n ? `Your cards (${n})` : "Your cards";
  cardsStatus.hidden = n > 0;
  cardsStatus.textContent = "Cards will appear here once your upload has been processed.";
}

// A labelled line inside an opened card, e.g. "Answer: ..." (label in bold, value as plain text).
function cardLine(className, label, value) {
  const p = el("p", className);
  p.append(el("strong", "", `${label}: `), document.createTextNode(value));
  return p;
}

// Draw the "Your cards" list. Each card is a collapsible <details> (the question; the answer, reasoning,
// references and origin when opened) with a Delete button beside it.
// Cards made before the prompt changed have `source` instead of `guideline` / `material_reference`; both work.
function renderCards(cards) {
  cardsEl.replaceChildren();

  for (const card of cards) {
    const c = card.content;
    const li = el("li", "card-row");
    const details = el("details", "card-item");
    details.append(el("summary", "", c.front));

    const body = el("div", "card-body");
    body.append(cardLine("card-answer", "Answer", c.back));
    if (c.reasoning) body.append(cardLine("", "Why", c.reasoning));
    if (c.guideline) body.append(cardLine("card-source", "Guideline", c.guideline));
    if (c.source) body.append(cardLine("card-source", "Source", c.source)); // older cards
    // Where it came from, e.g. "Tutorial 1.pdf · Page 3"
    const from = [card.uploads?.file_name, c.material_reference || c.location].filter(Boolean).join(" · ");
    if (from) body.append(el("p", "card-from", from));
    if (c.tags?.length) body.append(el("p", "card-from", `Tags: ${c.tags.join(", ")}`));
    if (c.priority) body.append(el("p", "card-from", `Priority ${c.priority}: ${PRIORITY_TEXT[c.priority - 1]}`));
    details.append(body);

    const remove = el("button", "link-btn danger", "Delete");
    remove.type = "button";
    remove.setAttribute("aria-label", `Delete card: ${c.front}`);
    remove.addEventListener("click", async () => {
      if (!window.confirm("Delete this card? This can't be undone.")) return;
      showError("");
      remove.disabled = true;
      try {
        await deleteCard(card.id);
        li.remove();
        syncCardsHeader();
      } catch (err) {
        showError(err.message || "Could not delete the card.");
        remove.disabled = false;
      }
    });

    li.append(details, remove);
    cardsEl.append(li);
  }
  syncCardsHeader();
}

// Load the user's cards and redraw the list.
async function refreshCards() {
  try {
    renderCards(await listCards());
  } catch (err) {
    cardsStatus.hidden = true;
    showError(err.message || "Could not load your cards.");
  }
}

// ---- Uploading ----

// Handle a batch of files from the picker or a drop. Files are processed one after another;
// each gets a line in the progress queue showing where it is.
async function upload(fileList) {
  const files = [...fileList];
  input.value = ""; // lets the same file be picked again later
  showError("");
  const cardCount = readCount(); // both settings are fixed for this batch, even if the controls change mid-upload
  const level = readLevel();

  for (const file of files) {
    const li = el("li");
    const state = el("span", "state");
    li.append(el("span", "name", file.name), state);
    queue.append(li);
    // Set the line's final state (drives its colour) and text.
    const finish = (kind, text) => {
      li.dataset.state = kind;
      state.textContent = text;
    };

    // Step 1: reject unsupported / empty / oversized files before uploading anything.
    const problem = validate(file);
    if (problem) {
      finish("error", problem);
      continue;
    }

    // Step 2: send the file to Storage, into this user's own folder.
    state.textContent = "Uploading…";
    let path;
    try {
      path = await uploadMaterial(userId, file);
    } catch (err) {
      finish("error", err.message || "Upload failed");
      continue;
    }

    // Step 3: record the upload in the database so the server can find it.
    let uploadId;
    try {
      uploadId = await createUpload({ fileName: file.name, fileType: typeOf(file.name), fileSize: file.size, storagePath: path });
    } catch (err) {
      await discardMaterial(path); // don't leave a file nothing knows about
      finish("error", err.message || "Couldn't record the upload");
      continue;
    }

    // Step 4: ask the server to start generating cards. This returns immediately; the status list shows progress.
    try {
      await startProcessing(uploadId, cardCount, level);
      finish("done", `Uploaded, generating ${cardCount} card${cardCount === 1 ? "" : "s"}`);
    } catch {
      finish("error", "Uploaded, but couldn't start. Use Start below.");
    }
    refreshUploads();
  }
  refreshUploads();
}

// Choosing files with the browse dialog...
input.addEventListener("change", () => input.files.length && upload(input.files));
// ...or dragging them onto the drop area. preventDefault stops the browser from just opening the file.
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over"); // highlights the drop area
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
}
drop.addEventListener("drop", (e) => e.dataTransfer.files.length && upload(e.dataTransfer.files));

// ---- Start-up ----

// Runs once on page load: make sure Supabase is set up and someone is signed in, then load the lists.
async function init() {
  if (!isConfigured) {
    uploadsStatus.textContent = "The portal is unavailable: Supabase is not configured on the server.";
    return;
  }
  // The portal is for signed-in users only; everyone else goes to the login page.
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    window.location.replace("login.html");
    return;
  }
  userId = data.session.user.id;

  // If the user logs out (here or in another tab), stop polling and leave the page.
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      clearTimeout(pollTimer);
      window.location.replace("login.html");
    }
  });
  await Promise.all([refreshUploads(), refreshCards()]);
}

init();
