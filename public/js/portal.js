// Logic for the upload section of the homepage (#upload in index.html). Visitors without an account are signed in
// anonymously so they can try the tool, with one free generation (the server enforces the limit; see
// lib/uploadRoute.js). After that, or if anonymous sign-in isn't available, they see a login prompt (#gate).
// The tool (#tool) itself works in two separate steps:
//   1. Upload: drop one or more files, or paste text -> upload each to Storage -> record it in `uploads`
//      (status 'uploaded'). Pasted text is saved as a .txt file, so it follows exactly the same path as any upload.
//      Files just wait; nothing is generated yet, and a waiting file can be removed.
//   2. Generate: the user presses the button -> the server is asked to generate cards for every waiting file,
//      using the card count and focus chosen at that moment -> the page polls their status until they're done
//      -> the generated cards are shown.
import { isConfigured, isMember, supabase } from "./supabaseClient.js";
import { discardMaterial, typeOf, uploadMaterial, validate } from "./storage.js";
import { createUpload, deleteCard, deleteUpload, listCards, listUploads, startProcessing } from "./uploads.js";

// Page elements, looked up once.
const gate = document.getElementById("gate"); // shown instead of the tool when signed out
const gateText = document.getElementById("gate-text");
const gateActions = document.getElementById("gate-actions");
const tool = document.getElementById("tool"); // the whole upload tool, shown when signed in
const inputs = document.getElementById("inputs"); // the part of it for adding material and generating
const freeNote = document.getElementById("free-note"); // "try it free" line, for visitors without an account
const fileMode = document.getElementById("file-mode"); // the drop zone...
const textMode = document.getElementById("text-mode"); // ...or the paste-text box; only one is visible at a time
const modeToggle = document.getElementById("mode-toggle");
const textInput = document.getElementById("text-input");
const textCount = document.getElementById("text-count");
const addTextBtn = document.getElementById("add-text");
const drop = document.getElementById("drop"); // the drag-and-drop area (also a <label> for the file input)
const input = document.getElementById("file");
const queue = document.getElementById("queue"); // per-file progress while uploading
const uploadsEl = document.getElementById("uploads"); // list of the user's uploads and their status
const uploadsStatus = document.getElementById("uploads-status");
const cardsEl = document.getElementById("cards"); // holds the groups of generated cards
const cardsStatus = document.getElementById("cards-status");
const cardsHeading = document.getElementById("cards-heading");
const errorEl = document.getElementById("error");
const countInput = document.getElementById("count"); // "Cards to generate" number field
const focusRadios = [...document.querySelectorAll('input[name="focus"]')]; // "Clinical" / "Preclinical" radio buttons
const settingsRadios = [...document.querySelectorAll('input[name="settings"]')]; // "Default" / "Advanced" radio buttons
const advDialog = document.getElementById("adv-dialog"); // the advanced-settings popup and its fields
const advForm = document.getElementById("adv-form");
const advEdit = document.getElementById("adv-edit"); // "Edit advanced settings" button
const advSummary = document.getElementById("adv-summary"); // one-line description of the saved advanced settings
const difficultyRadios = [...document.querySelectorAll('input[name="difficulty"]')];
const yearCourse = document.getElementById("year-course"); // course dropdown: undergraduate / GEM
const yearNum = document.getElementById("year-num"); // year dropdown; its options depend on the course
const contextInput = document.getElementById("context"); // optional free-text context for the AI
const contextCount = document.getElementById("context-count");
const generateBtn = document.getElementById("generate"); // the "Generate cards" button
const generateHint = document.getElementById("generate-hint"); // text beside it: how many files are ready

const MIN_CARDS = 1;
const MAX_CARDS = 50; // keep in step with lib/processUpload.js
const MAX_FILES_PER_BATCH = 10; // files accepted from one drop / file-picker selection
const MAX_CONTEXT_CHARS = 1000; // keep in step with the context textarea's maxlength and lib/prompts.js
const MAX_TEXT_CHARS = 300000; // keep in step with the textarea's maxlength (about the most the server will process)

const POLL_MS = 2500; // how often to re-check upload status while something is processing
const START_GRACE_MS = 60000; // how long to keep polling a file we asked the server to start but that still shows as waiting
const PRIORITY_TEXT = ["core knowledge", "useful", "extra detail"]; // meaning of a card's priority 1, 2, 3
const STATUS_TEXT = { uploaded: "Ready to generate", processing: "Generating cards…", done: "Done" };

const LIMIT_TEXT = "You've used your free generation. Log in or sign up to make more cards.";

let userId = null; // set once we know who is signed in
let isAnon = false; // true for a visitor without an account (anonymous session): one free generation
let freeUsed = false; // an anonymous visitor's free generation has been started or finished
let pollTimer = null; // handle for the pending status poll, so it can be cancelled
let lastStatuses = new Map(); // upload id -> status at the previous poll, used to spot newly finished uploads
let waitingRows = []; // uploads still 'uploaded': stored and ready, waiting for the Generate button
let uploadingNow = 0; // files currently being uploaded (the Generate button waits for these)
let generating = false; // true while the page is asking the server to start files
const started = new Map(); // upload id -> when we asked the server to start it, until its status changes

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

// ---- Card focus ----

// The chosen focus, "clinical" or "preclinical" ("clinical" is checked by default in the HTML).
// This is only what the user picked: the server checks it again and falls back to "clinical" for anything else.
const readFocus = () => focusRadios.find((r) => r.checked)?.value ?? "clinical";

// Restore the last choice, and remember new ones.
try {
  const saved = focusRadios.find((r) => r.value === localStorage.getItem("meddeck.focus"));
  if (saved) saved.checked = true;
} catch {
  // ignore: storage can be unavailable
}
for (const radio of focusRadios) {
  radio.addEventListener("change", () => {
    try {
      localStorage.setItem("meddeck.focus", readFocus());
    } catch {
      // ignore: the choice just isn't remembered
    }
  });
}

// ---- Advanced settings ----

// The page offers "Default" settings or "Advanced" ones chosen in a popup: difficulty, year group and context.
// Default means medium difficulty, no year group and no context. Advanced values are only used while "Advanced" is
// selected, are not remembered between visits (they usually belong to the material being generated), and are checked
// again by the server, so this is only what the user picked.
const DEFAULTS = { difficulty: "medium", course: "undergraduate", year: "", context: "" };
const COURSE_YEARS = { undergraduate: 5, gem: 4 }; // years offered for each course; keep in step with lib/prompts.js
const COURSE_NAMES = { undergraduate: "Undergraduate medicine", gem: "GEM" };

let advanced = { ...DEFAULTS }; // the last saved advanced settings (year is "" or a year number as text)
let advancedSaved = false; // the popup has been saved at least once
let useAdvanced = false; // "Advanced" is selected and its saved settings apply

// Fill the year dropdown with "Not specified" and one option per year of the course, selecting `selected` if given.
function fillYears(course, selected = "") {
  yearNum.replaceChildren(new Option("Not specified", ""));
  for (let y = 1; y <= COURSE_YEARS[course]; y++) yearNum.append(new Option(`Year ${y}`, String(y)));
  yearNum.value = selected;
}
yearCourse.addEventListener("change", () => fillYears(yearCourse.value)); // a different course has different years

const updateContextCount = () => {
  contextCount.textContent = `${contextInput.value.length.toLocaleString()} / ${MAX_CONTEXT_CHARS.toLocaleString()} characters`;
};
contextInput.addEventListener("input", updateContextCount);

// Everything that goes to the server besides the card count and focus. Only the saved advanced settings count, and
// only while "Advanced" is selected; otherwise the defaults are sent.
function readAdvanced() {
  const a = useAdvanced ? advanced : DEFAULTS;
  return {
    difficulty: a.difficulty,
    yearGroup: a.year ? { course: a.course, year: Number(a.year) } : null,
    context: a.context.trim(),
  };
}

// Show or hide the Edit button and the one-line summary, e.g. "Difficult · GEM year 2 · with context".
function updateAdvancedUi() {
  advEdit.hidden = !useAdvanced;
  if (!useAdvanced) {
    advSummary.textContent = "";
    return;
  }
  const parts = [advanced.difficulty[0].toUpperCase() + advanced.difficulty.slice(1)];
  if (advanced.year) parts.push(`${COURSE_NAMES[advanced.course]} year ${advanced.year}`);
  if (advanced.context.trim()) parts.push("with context");
  advSummary.textContent = parts.join(" · ");
}

// Open the popup showing the saved values (or the defaults the first time).
function openAdvanced() {
  const values = advancedSaved ? advanced : DEFAULTS;
  for (const radio of difficultyRadios) radio.checked = radio.value === values.difficulty;
  yearCourse.value = values.course;
  fillYears(values.course, values.year);
  contextInput.value = values.context;
  updateContextCount();
  advDialog.returnValue = "";
  advDialog.showModal();
}

// Save: copy the fields into `advanced` and close.
advForm.addEventListener("submit", (e) => {
  e.preventDefault();
  advanced = {
    difficulty: difficultyRadios.find((r) => r.checked)?.value ?? DEFAULTS.difficulty,
    course: yearCourse.value,
    year: yearNum.value,
    context: contextInput.value,
  };
  advancedSaved = true;
  advDialog.close("save");
});
document.getElementById("adv-cancel").addEventListener("click", () => advDialog.close("cancel"));
// Clicking the dimmed area outside the popup cancels it (Escape does too, natively).
advDialog.addEventListener("click", (e) => e.target === advDialog && advDialog.close("cancel"));

// However the popup closed, line the radio buttons and summary up with what is actually saved. Cancelling before
// anything was ever saved returns to Default; cancelling later keeps the previous advanced settings.
advDialog.addEventListener("close", () => {
  useAdvanced = advancedSaved;
  const current = settingsRadios.find((r) => r.value === (useAdvanced ? "advanced" : "default"));
  if (current) current.checked = true;
  updateAdvancedUi();
  updateGenerateButton();
});

// Choosing "Advanced" opens the popup; choosing "Default" just stops using the saved advanced settings.
for (const radio of settingsRadios) {
  radio.addEventListener("change", () => {
    if (radio.value === "advanced") {
      openAdvanced();
    } else {
      useAdvanced = false;
      updateAdvancedUi();
      updateGenerateButton();
    }
  });
}
advEdit.addEventListener("click", openAdvanced);

// Show (or clear, with empty text) the red error line above the lists.
function showError(text) {
  errorEl.textContent = text || "";
  errorEl.hidden = !text;
}

// ---- Generate button ----

// Enable or disable the button and update the line beside it. The button is only usable when at least one file is
// waiting, and not while files are still uploading or while the server is being asked to start.
function updateGenerateButton() {
  const n = waitingRows.filter((r) => !started.has(r.id)).length; // files that haven't already been started
  generateBtn.disabled = generating || uploadingNow > 0 || n === 0;
  if (uploadingNow > 0) {
    generateHint.textContent = "Uploading…";
  } else if (generating) {
    generateHint.textContent = "Starting…";
  } else if (n === 0) {
    generateHint.textContent = "Add a file or some text to get started.";
  } else {
    const cards = readCount();
    const focus = readFocus() === "preclinical" ? "preclinical" : "clinical";
    const advancedNote = useAdvanced ? " · advanced settings" : "";
    generateHint.textContent = `${n} item${n === 1 ? "" : "s"} ready · ${cards} card${cards === 1 ? "" : "s"} each · ${focus} focus${advancedNote}`;
  }
}
// The hint shows the current settings, so it follows them as they change (these run after the controls' own handlers).
for (const id of ["count-down", "count-up"]) document.getElementById(id).addEventListener("click", updateGenerateButton);
countInput.addEventListener("input", updateGenerateButton);
countInput.addEventListener("change", updateGenerateButton);
for (const radio of focusRadios) radio.addEventListener("change", updateGenerateButton);

// Pressing Generate asks the server to start every waiting file. The settings are read now, at the moment of the
// click, so they apply to exactly what the user sees. The server returns straight away for each file;
// progress then shows in the uploads list.
generateBtn.addEventListener("click", async () => {
  const settings = { cardCount: readCount(), focus: readFocus(), ...readAdvanced() };
  const targets = waitingRows.filter((r) => !started.has(r.id));
  if (!targets.length || generating) return;

  generating = true; // also stops a double click from sending the requests twice
  showError("");
  updateGenerateButton();
  let failed = 0;
  let firstProblem = "";
  for (const row of targets) {
    try {
      await startProcessing(row.id, settings);
      started.set(row.id, Date.now());
    } catch (err) {
      failed++;
      firstProblem ||= err.message;
      if (err.code === "free_limit") freeUsed = true; // the server says the free generation is gone
    }
  }
  generating = false;
  syncFreeState();
  if (failed) {
    showError(
      failed === targets.length
        ? firstProblem
        : `${failed} of ${targets.length} items couldn't be started. Press Generate again to retry them.`
    );
  }
  refreshUploads();
});

// ---- Free trial ----

// Match the page to the visitor's free-trial state. Once it's used up, the add/generate controls give way to the
// login prompt, while their uploads and cards stay visible. Members are unaffected.
function syncFreeState() {
  if (!isAnon) return;
  inputs.hidden = freeUsed;
  freeNote.hidden = freeUsed;
  if (freeUsed) showGate(LIMIT_TEXT);
  else gate.hidden = true;
}

// ---- Uploads list ----

// Draw the "Your uploads" list: file name, date and a status badge. Files that are waiting get a Remove button.
function renderUploads(rows) {
  uploadsEl.replaceChildren();
  uploadsStatus.hidden = rows.length > 0;
  uploadsStatus.textContent = "You haven't uploaded anything yet.";

  for (const row of rows) {
    const li = el("li");
    li.dataset.status = row.status; // CSS colours the badge based on this

    const info = el("div", "file-info");
    info.append(el("span", "file-name", row.file_name), el("span", "file-meta", new Date(row.created_at).toLocaleString()));

    // A file we've just asked the server to start still says 'uploaded' for a moment; show it as generating already.
    const starting = row.status === "uploaded" && started.has(row.id);
    const state = el("div", "file-state");
    const label = starting ? STATUS_TEXT.processing : row.status === "failed" ? "Failed" : STATUS_TEXT[row.status] || row.status;
    state.append(el("span", "badge", label));
    if (row.status === "processing" || starting) state.firstChild.classList.add("busy"); // shows the spinner
    if (row.status === "failed" && row.error) state.append(el("span", "file-error", row.error));
    // A waiting file can be taken back out before generating: this deletes its row and the stored file.
    if (row.status === "uploaded" && !starting) {
      const remove = el("button", "link-btn danger", "Remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${row.file_name}`);
      remove.addEventListener("click", async () => {
        showError("");
        remove.disabled = true;
        try {
          await deleteUpload(row.id);
          if (!(await discardMaterial(row.storage_path))) showError("The upload was removed, but its stored file couldn't be deleted.");
        } catch (err) {
          showError(err.message || "Could not remove the upload.");
          remove.disabled = false;
          return;
        }
        refreshUploads();
      });
      state.append(remove);
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

  // Forget files we started once their status has moved on (or after a minute, if the server never picked them up).
  for (const [id, since] of started) {
    const row = rows.find((r) => r.id === id);
    if (!row || row.status !== "uploaded" || Date.now() - since > START_GRACE_MS) started.delete(id);
  }
  waitingRows = rows.filter((r) => r.status === "uploaded");
  // The free generation counts as used once any upload has been started (matches the rule in lib/uploadRoute.js).
  if (isAnon) freeUsed = rows.some((r) => r.status === "processing" || r.status === "done" || (r.status === "uploaded" && started.has(r.id)));
  renderUploads(rows);
  syncFreeState();
  updateGenerateButton();

  // A row that just finished means new cards are available.
  const justFinished = rows.some((r) => r.status === "done" && lastStatuses.get(r.id) !== "done" && lastStatuses.has(r.id));
  lastStatuses = new Map(rows.map((r) => [r.id, r.status]));
  if (justFinished) refreshCards();

  // Keep checking while anything is being generated. A waiting file only needs checking if we've just started it
  // (its status flips to 'processing' a moment after the server accepts the request); otherwise it just sits there.
  if (rows.some((r) => r.status === "processing" || (r.status === "uploaded" && started.has(r.id)))) {
    pollTimer = setTimeout(refreshUploads, POLL_MS);
  }
}

// ---- Cards list ----

// Every card carries labels the model chose (see lib/prompts.js): subject, topic, difficulty and type (aspect).
// The page can search, filter and group by them. Cards made before the labels existed lack them and are shown as
// "Unsorted" / "Not rated" / "Not set" instead of disappearing. Display names below match the lists in lib/prompts.js.
const DIFFICULTY_LABELS = { easy: "Easy", medium: "Medium", difficult: "Difficult" };
const ASPECT_LABELS = {
  presentation: "Presentation",
  investigation: "Investigation",
  management: "Management",
  mechanism: "Mechanism",
  complications: "Complications",
  fundamentals: "Fundamentals",
};
const UNSORTED = "Unsorted"; // subject shown for cards without one
const NO_TOPIC = "General"; // topic group for cards without one
const FALLBACK_LABELS = new Set([UNSORTED, NO_TOPIC, "Other", "Not rated", "Not set", "Unknown source"]); // always sorted last

// The value of a card for each thing it can be filtered or grouped by, as the text shown to the user.
const FACETS = {
  subject: (card) => card.content.subject || UNSORTED,
  difficulty: (card) => DIFFICULTY_LABELS[card.content.difficulty] || "Not rated",
  aspect: (card) => ASPECT_LABELS[card.content.aspect] || "Not set",
  source: (card) => card.uploads?.file_name || "Unknown source",
};
const filterSelects = {
  subject: document.getElementById("filter-subject"),
  difficulty: document.getElementById("filter-difficulty"),
  aspect: document.getElementById("filter-aspect"),
  source: document.getElementById("filter-source"),
};
const cardsToolbar = document.getElementById("cards-toolbar");
const cardSearch = document.getElementById("card-search");
const groupSelect = document.getElementById("group-by");
const filterClear = document.getElementById("filter-clear");
const cardsShowing = document.getElementById("cards-showing");
const groupsExpand = document.getElementById("groups-expand");
const groupsCollapse = document.getElementById("groups-collapse");

let allCards = []; // every card the user has, as loaded
const filters = { subject: "", difficulty: "", aspect: "", source: "" }; // "" means All
let searchText = "";
const closedGroups = new Set(); // groups the user has collapsed, so redrawing keeps them collapsed

// Restore the last "Group by" choice (a convenience only, so a failure to read it is ignored).
try {
  const saved = localStorage.getItem("meddeck.groupBy");
  if ([...groupSelect.options].some((o) => o.value === saved)) groupSelect.value = saved;
} catch {
  // ignore: storage can be unavailable
}

const isFiltering = () => Boolean(searchText) || Object.values(filters).some(Boolean);

// Order a list of labels for display: difficulty runs easy -> difficult, everything else is alphabetical, and the
// "no value" labels (Unsorted, General, Other, ...) go last.
function sortLabels(key, labels) {
  const rank = (l) => (key === "difficulty" ? Object.values(DIFFICULTY_LABELS).indexOf(l) : 0);
  return [...labels].sort((a, b) => FALLBACK_LABELS.has(a) - FALLBACK_LABELS.has(b) || rank(a) - rank(b) || a.localeCompare(b));
}

// Rebuild the filter dropdowns from the values that actually exist, keeping the current choice where it still applies.
// A dropdown with fewer than two different values would filter nothing, so it is hidden.
function fillFilters() {
  for (const [key, select] of Object.entries(filterSelects)) {
    const labels = sortLabels(key, new Set(allCards.map(FACETS[key])));
    if (filters[key] && !labels.includes(filters[key])) filters[key] = "";
    select.replaceChildren(new Option("All", ""), ...labels.map((l) => new Option(l, l)));
    select.value = filters[key];
    select.parentElement.hidden = labels.length < 2;
  }
}

// Does this card pass the current filters and search?
function matches(card) {
  for (const key of Object.keys(filters)) if (filters[key] && FACETS[key](card) !== filters[key]) return false;
  if (!searchText) return true;
  const c = card.content;
  const haystack = [c.front, c.back, c.reasoning, c.guideline, c.source, c.subject, c.topic, ...(c.tags || [])];
  return haystack.join("\n").toLowerCase().includes(searchText);
}

// A labelled line inside an opened card, e.g. "Answer: ..." (label in bold, value as plain text).
function cardLine(className, label, value) {
  const p = el("p", className);
  p.append(el("strong", "", `${label}: `), document.createTextNode(value));
  return p;
}

// The row of small coloured labels shown under a card's question.
function chipRow(card) {
  const c = card.content;
  const row = el("span", "chips");
  if (c.subject) row.append(el("span", "chip chip-subject", c.subject));
  if (c.topic) row.append(el("span", "chip chip-topic", c.topic));
  if (DIFFICULTY_LABELS[c.difficulty]) row.append(el("span", `chip chip-${c.difficulty}`, DIFFICULTY_LABELS[c.difficulty]));
  if (ASPECT_LABELS[c.aspect]) row.append(el("span", "chip chip-aspect", ASPECT_LABELS[c.aspect]));
  return row;
}

// One card: a collapsible <details> (the question and its labels; the answer, reasoning, references and origin when
// opened) with a Delete button beside it.
// Cards made before the prompt changed have `source` instead of `guideline` / `material_reference`; both work.
function cardRow(card) {
  const c = card.content;
  const li = el("li", "card-row");
  const details = el("details", "card-item");
  const summary = el("summary");
  const question = el("span", "card-q");
  question.append(el("span", "", c.front), chipRow(card));
  summary.append(question);
  details.append(summary);

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
      allCards = allCards.filter((x) => x.id !== card.id);
      fillFilters();
      renderCards();
    } catch (err) {
      showError(err.message || "Could not delete the card.");
      remove.disabled = false;
    }
  });

  li.append(details, remove);
  return li;
}

// A list of cards, most important first (priority 1 = core knowledge; a missing priority counts as 2).
function cardList(cards) {
  const ul = el("ul", "cards");
  ul.append(...[...cards].sort((a, b) => (a.content.priority ?? 2) - (b.content.priority ?? 2)).map(cardRow));
  return ul;
}

// Split cards into labelled groups: [[label, cards], ...] in display order. `keyOf` gives each card's group label.
function groupCards(cards, groupKey, keyOf) {
  const groups = new Map();
  for (const card of cards) {
    const label = keyOf(card);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(card);
  }
  return sortLabels(groupKey, groups.keys()).map((label) => [label, groups.get(label)]);
}

// A collapsible group with a count. With `byTopic`, its cards are split under topic headings.
// While searching or filtering, groups are always open so matches can't be hidden inside a collapsed one.
function groupElement(mode, label, cards, byTopic) {
  const id = `${mode}|${label}`;
  const details = el("details", "group");
  details.open = isFiltering() || !closedGroups.has(id);
  const summary = el("summary");
  summary.append(el("span", "group-name", label), el("span", "group-count", String(cards.length)));
  details.append(summary);
  // Remember what the user opens and closes (ignored while filtering, when everything is forced open).
  details.addEventListener("toggle", () => {
    if (isFiltering()) return;
    if (details.open) closedGroups.delete(id);
    else closedGroups.add(id);
  });

  const body = el("div", "group-body");
  if (byTopic) {
    for (const [topic, items] of groupCards(cards, "topic", (card) => card.content.topic || NO_TOPIC)) {
      const section = el("section", "topic");
      section.append(el("h4", "topic-name", `${topic} (${items.length})`), cardList(items));
      body.append(section);
    }
  } else {
    body.append(cardList(cards));
  }
  details.append(body);
  return details;
}

// Redraw the toolbar state and the cards for the current filters, search and grouping.
function renderCards() {
  const n = allCards.length;
  cardsHeading.textContent = n ? `Your cards (${n})` : "Your cards";
  cardsStatus.hidden = n > 0;
  cardsStatus.textContent = "Cards will appear here once your upload has been processed.";
  cardsToolbar.hidden = n === 0;
  cardsEl.replaceChildren();
  if (!n) return;

  const visible = allCards.filter(matches);
  const mode = groupSelect.value;
  filterClear.hidden = !isFiltering();
  cardsShowing.textContent = isFiltering() ? `Showing ${visible.length} of ${n} card${n === 1 ? "" : "s"}` : "";
  groupsExpand.hidden = groupsCollapse.hidden = mode === "none";

  if (!visible.length) {
    cardsEl.append(el("p", "portal-empty", "No cards match your search and filters."));
  } else if (mode === "none") {
    cardsEl.append(cardList(visible));
  } else {
    // "Subject and topic" groups by subject with topic headings inside; the others are a single level of groups.
    const groupKey = mode === "subject" ? "subject" : mode;
    for (const [label, items] of groupCards(visible, groupKey, FACETS[groupKey])) {
      cardsEl.append(groupElement(mode, label, items, mode === "subject"));
    }
  }
}

// Wire up the toolbar.
cardSearch.addEventListener("input", () => {
  searchText = cardSearch.value.trim().toLowerCase();
  renderCards();
});
for (const [key, select] of Object.entries(filterSelects)) {
  select.addEventListener("change", () => {
    filters[key] = select.value;
    renderCards();
  });
}
groupSelect.addEventListener("change", () => {
  try {
    localStorage.setItem("meddeck.groupBy", groupSelect.value);
  } catch {
    // ignore: the choice just isn't remembered
  }
  renderCards();
});
filterClear.addEventListener("click", () => {
  searchText = cardSearch.value = "";
  for (const key of Object.keys(filters)) filters[key] = "";
  fillFilters();
  renderCards();
});
// Expand / collapse every group at once. (Collapsing is remembered; both are moot while a search or filter is active.)
groupsExpand.addEventListener("click", () => {
  closedGroups.clear();
  renderCards();
});
groupsCollapse.addEventListener("click", () => {
  for (const g of cardsEl.querySelectorAll("details.group")) closedGroups.add(`${groupSelect.value}|${g.querySelector(".group-name").textContent}`);
  renderCards();
});

// Load the user's cards and redraw the list.
async function refreshCards() {
  try {
    allCards = await listCards();
    fillFilters();
    renderCards();
  } catch (err) {
    cardsStatus.hidden = true;
    showError(err.message || "Could not load your cards.");
  }
}

// ---- Uploading ----

// Handle a batch of files from the picker or a drop. Files are uploaded one after another and each gets a line
// in the progress queue. Uploading only stores the file and records it as waiting: generating is a separate step
// (the Generate button). Resolves to true only if every file was stored.
async function upload(fileList) {
  let files = [...fileList];
  input.value = ""; // lets the same file be picked again later
  showError("");
  queue.replaceChildren(); // a fresh progress list for this batch
  if (files.length > MAX_FILES_PER_BATCH) {
    showError(`You selected ${files.length} files. The first ${MAX_FILES_PER_BATCH} were added; upload the rest in another batch.`);
    files = files.slice(0, MAX_FILES_PER_BATCH);
  }
  // The free trial covers a single file or text. (The server also refuses to start anything else.)
  if (isAnon) {
    if (freeUsed) return false;
    if (waitingRows.length + files.length > 1) {
      showError("The free trial covers one file or text. Remove the waiting item first, or log in to add more.");
      return false;
    }
  }
  uploadingNow += files.length;
  updateGenerateButton();

  let allStored = true;
  for (const file of files) {
    try {
      allStored = (await uploadOne(file)) && allStored;
    } finally {
      uploadingNow--; // whatever happened to this file, it is no longer uploading
      updateGenerateButton();
    }
    await refreshUploads(); // show each file in the list as soon as it is ready
  }
  return allStored;
}

// Validate, store and record a single file, reporting its progress on its own line in the queue.
// Resolves to true if the file was stored and recorded.
async function uploadOne(file) {
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
  if (problem) return finish("error", problem);

  // Step 2: send the file to Storage, into this user's own folder.
  state.textContent = "Uploading…";
  let path;
  try {
    path = await uploadMaterial(userId, file);
  } catch (err) {
    return finish("error", err.message || "Upload failed");
  }

  // Step 3: record the upload in the database (status 'uploaded'). It now waits for the Generate button.
  try {
    await createUpload({ fileName: file.name, fileType: typeOf(file.name), fileSize: file.size, storagePath: path });
  } catch (err) {
    await discardMaterial(path); // don't leave a file nothing knows about
    return finish("error", err.message || "Couldn't record the upload");
  }
  finish("done", "Uploaded, ready to generate");
  return true;
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

// ---- Pasted text ----

// The button above the input area swaps between the drop zone and the text box.
modeToggle.addEventListener("click", () => {
  const toText = textMode.hidden; // currently showing files, so switch to text
  textMode.hidden = !toText;
  fileMode.hidden = toText;
  modeToggle.textContent = toText ? "Upload files instead" : "Paste text instead";
  if (toText) textInput.focus();
});

const updateTextCount = () => {
  textCount.textContent = `${textInput.value.length.toLocaleString()} / ${MAX_TEXT_CHARS.toLocaleString()} characters`;
};
textInput.addEventListener("input", updateTextCount);

// "Add text" wraps the text in a .txt file named after its first words, then uploads it like any other file.
// It is then a waiting item in the list, and the Generate button treats it the same as an uploaded file.
addTextBtn.addEventListener("click", async () => {
  const text = textInput.value.trim();
  if (!text) return showError("Paste or type some text first.");
  const words = text.replace(/\s+/g, " ").slice(0, 40).trim();
  const file = new File([text], `Pasted text - ${words}.txt`, { type: "text/plain" });

  addTextBtn.disabled = true;
  try {
    if (await upload([file])) {
      textInput.value = ""; // it's safely stored, so clear the box for the next one
      updateTextCount();
    }
  } finally {
    addTextBtn.disabled = false;
  }
});

// ---- Start-up ----

// Show the login prompt in place of the tool. `text` replaces the default message; `withLinks` false hides the buttons.
function showGate(text, withLinks = true) {
  if (text) gateText.textContent = text;
  gateActions.hidden = !withLinks;
  gate.hidden = false;
}

// Runs once on page load: make sure Supabase is set up and someone is signed in, then load the lists.
async function init() {
  if (!isConfigured) {
    showGate("Uploads are unavailable: Supabase is not configured on the server.", false);
    return;
  }
  // Visitors without an account get an anonymous session, which lets them use the tool once. Their session is
  // remembered by the browser, so they keep the same free trial (and cards) on later visits.
  let { data } = await supabase.auth.getSession();
  if (!data.session) {
    ({ data } = await supabase.auth.signInAnonymously());
    // Anonymous sign-ins can be switched off in Supabase; then the tool needs a real account.
    if (!data.session) {
      showGate();
      return;
    }
  }
  const { session } = data;
  userId = session.user.id;
  isAnon = !isMember(session);
  tool.hidden = false;
  freeNote.hidden = !isAnon;

  // Reload when the login state changes for real: logging out (here or in another tab), or a free-trial visitor
  // logging in elsewhere. Polling stops first.
  supabase.auth.onAuthStateChange((event, next) => {
    if (event === "SIGNED_OUT" || (isAnon && event === "SIGNED_IN" && isMember(next))) {
      clearTimeout(pollTimer);
      window.location.reload();
    }
  });
  await Promise.all([refreshUploads(), refreshCards()]);
}

init();
