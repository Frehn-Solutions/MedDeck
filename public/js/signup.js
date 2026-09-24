// Logic for signup.html: validate the form, create the account with Supabase, then go to the home page.
import { isConfigured, isMember, signUp, supabase } from "./supabaseClient.js";

const form = document.getElementById("signup-form");
const msg = document.getElementById("msg"); // status / error line under the button
const submit = document.getElementById("submit");

// Show a message under the form. `kind` ("error" or "success") only changes its colour.
function show(text, kind) {
  msg.textContent = text;
  msg.dataset.kind = kind || "";
}

if (!isConfigured) {
  show("Signup is unavailable: Supabase is not configured on the server.", "error");
  submit.disabled = true;
} else {
  // Someone who is already signed in has no reason to see this page.
  supabase.auth.getSession().then(({ data }) => {
    if (isMember(data.session)) window.location.replace("/"); // a free-trial (anonymous) session doesn't count
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault(); // handle the form here instead of letting the browser reload the page
  const name = form.name.value.trim();
  const email = form.email.value.trim();
  const password = form.password.value;

  // Client-side checks give instant feedback; Supabase enforces its own rules too.
  if (!/^\S+@\S+\.\S+$/.test(email)) return show("Please enter a valid email address.", "error");
  if (password.length < 8) return show("Password must be at least 8 characters.", "error");
  if (password !== form.confirm.value) return show("Passwords do not match.", "error");
  if (!form.terms.checked) return show("Please acknowledge the educational-use disclaimer.", "error");

  submit.disabled = true; // prevents double submissions while the request is in flight
  show("Creating your account…");
  try {
    const { session } = await signUp(email, password, name ? { full_name: name } : {});
    form.reset();
    // A session comes back straight away when email confirmation is off; otherwise the user must confirm first.
    if (session) {
      show("Account created. Taking you to the homepage…", "success");
      setTimeout(() => window.location.replace("/"), 800);
      return; // leave the button disabled while we redirect
    }
    show("Almost done! Check your email for a confirmation link.", "success");
  } catch (err) {
    show(err.message || "Something went wrong. Please try again.", "error");
  }
  submit.disabled = false;
});
