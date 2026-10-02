// Logic for account.html: shows the signed-in member's profile and lets them update their display name, password
// and saved year group. Everything here is stored on the Supabase account itself (auth.updateUser's `data`, which
// Supabase merges into the existing user_metadata rather than replacing it), so it follows the user to any device,
// unlike the per-generation settings on the homepage which only live in this browser.
import { isConfigured, isMember, supabase } from "./supabaseClient.js";

const profileForm = document.getElementById("profile-form");
const displayName = document.getElementById("display-name");
const emailField = document.getElementById("email");
const profileMsg = document.getElementById("profile-msg");
const profileSave = document.getElementById("profile-save");

const passwordForm = document.getElementById("password-form");
const newPassword = document.getElementById("new-password");
const confirmPassword = document.getElementById("confirm-password");
const passwordMsg = document.getElementById("password-msg");
const passwordSave = document.getElementById("password-save");

const yearForm = document.getElementById("year-form");
const yearCourse = document.getElementById("year-course");
const yearNum = document.getElementById("year-num");
const yearMsg = document.getElementById("year-msg");
const yearSave = document.getElementById("year-save");

const COURSE_YEARS = { undergraduate: 5, gem: 4 }; // years offered per course; keep in step with js/portal.js

// Show a message under a form. `kind` ("error" or "success") only changes its colour.
function show(el, text, kind) {
  el.textContent = text;
  el.dataset.kind = kind || "";
}

// Fill the year dropdown with "Not specified" and one option per year of the course, selecting `selected` if given.
function fillYears(course, selected = "") {
  yearNum.replaceChildren(new Option("Not specified", ""));
  for (let y = 1; y <= COURSE_YEARS[course]; y++) yearNum.append(new Option(`Year ${y}`, String(y)));
  yearNum.value = selected;
}
yearCourse.addEventListener("change", () => fillYears(yearCourse.value));

// Every field is useless without Supabase or a real session; disable them all and explain why.
function disableAll(message) {
  for (const form of [profileForm, passwordForm, yearForm]) {
    for (const field of form.elements) field.disabled = true;
  }
  show(profileMsg, message, "error");
}

async function init() {
  if (!isConfigured) return disableAll("Account settings are unavailable: Supabase is not configured on the server.");

  const { data } = await supabase.auth.getSession();
  // A free-trial (anonymous) session doesn't have a password or email to manage; send it to log in or sign up.
  if (!isMember(data.session)) {
    window.location.replace("login.html");
    return;
  }
  const { user } = data.session;

  emailField.value = user.email;
  displayName.value = user.user_metadata?.full_name || "";

  const savedYear = user.user_metadata?.year_group; // { course, year } or absent
  yearCourse.value = savedYear?.course === "gem" ? "gem" : "undergraduate";
  fillYears(yearCourse.value, savedYear?.year ? String(savedYear.year) : "");
}

profileForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  profileSave.disabled = true;
  show(profileMsg, "Saving…");
  try {
    const { error } = await supabase.auth.updateUser({ data: { full_name: displayName.value.trim() } });
    if (error) throw error;
    show(profileMsg, "Profile saved.", "success");
  } catch (err) {
    show(profileMsg, err.message || "Couldn't save your profile.", "error");
  }
  profileSave.disabled = false;
});

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (newPassword.value.length < 8) return show(passwordMsg, "Password must be at least 8 characters.", "error");
  if (newPassword.value !== confirmPassword.value) return show(passwordMsg, "Passwords do not match.", "error");

  passwordSave.disabled = true;
  show(passwordMsg, "Updating…");
  try {
    const { error } = await supabase.auth.updateUser({ password: newPassword.value });
    if (error) throw error;
    passwordForm.reset();
    show(passwordMsg, "Password updated.", "success");
  } catch (err) {
    show(passwordMsg, err.message || "Couldn't update your password.", "error");
  }
  passwordSave.disabled = false;
});

yearForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  yearSave.disabled = true;
  show(yearMsg, "Saving…");
  try {
    const year_group = yearNum.value ? { course: yearCourse.value, year: Number(yearNum.value) } : null;
    const { error } = await supabase.auth.updateUser({ data: { year_group } });
    if (error) throw error;
    show(yearMsg, "Preferences saved.", "success");
  } catch (err) {
    show(yearMsg, err.message || "Couldn't save your preferences.", "error");
  }
  yearSave.disabled = false;
});

init();
