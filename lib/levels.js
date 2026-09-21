// Study levels a user can choose on the portal. `instruction` is inserted into prompt.txt wherever
// {LEVEL_INSTRUCTION} appears, so it should read as sentences that follow "...preparing for exams such as the UKMLA."
// The wording below is a first draft: edit it freely, and add or remove levels here (the page's selector is built from this list).
const LEVELS = {
  preclinical: {
    label: "Pre-clinical (years 1-2)",
    instruction:
      "They are in the early, pre-clinical years, so favour foundational science: normal structure and function, basic disease mechanisms, and simple links to clinical practice.",
  },
  clinical: {
    label: "Clinical years",
    instruction:
      "They are in the clinical years, so favour common presentations, key investigations, and the reasoning behind first-line management.",
  },
  finals: {
    label: "Finals / UKMLA revision",
    instruction:
      "They are close to finals, so focus on high-yield exam facts: recognising common presentations, choosing key investigations, and first-line management and safety.",
  },
};

const DEFAULT_LEVEL = "finals";

// True only for a real level id (Object.hasOwn stops inherited names like "constructor" from matching).
const isLevel = (id) => typeof id === "string" && Object.hasOwn(LEVELS, id);

module.exports = { LEVELS, DEFAULT_LEVEL, isLevel };
