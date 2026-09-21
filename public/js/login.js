// Logic for login.html: validate the form, sign in with Supabase, then go to the home page.
import { isConfigured, logIn, supabase } from "./supabaseClient.js";

const form = document.getElementById("login-form");
const msg = document.getElementById("msg"); // status / error line under the button
const submit = document.getElementById("submit");

// Show a message under the form. `kind` ("error" or "success") only changes its colour.
function show(text, kind) {
  msg.textContent = text;
  msg.dataset.kind = kind || "";
}

if (!isConfigured) {
  show("Login is unavailable: Supabase is not configured on the server.", "error");
  submit.disabled = true;
} else {
  // Someone who is already signed in has no reason to see this page.
  supabase.auth.getSession().then(({ data }) => {
    if (data.session) window.location.replace("/");
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault(); // handle the form here instead of letting the browser reload the page
  const email = form.email.value.trim();
  const password = form.password.value;

  // Quick checks first; Supabase does the real authentication.
  if (!/^\S+@\S+\.\S+$/.test(email)) return show("Please enter a valid email address.", "error");
  if (!password) return show("Please enter your password.", "error");

  submit.disabled = true; // prevents double submissions while the request is in flight
  show("Logging in…");
  try {
    await logIn(email, password);
    window.location.replace("/"); // replace() so the Back button doesn't return to the login form
  } catch (err) {
    show(err.message || "Something went wrong. Please try again.", "error");
    submit.disabled = false;
  }
});
