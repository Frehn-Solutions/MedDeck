// Small bits of behaviour for the landing page (index.html).

// Keep the footer's copyright year current.
document.getElementById("year").textContent = new Date().getFullYear();

// The "get early access" email form at the bottom of the page.
const form = document.querySelector(".signup");
const msg = document.querySelector(".form-msg");

form.addEventListener("submit", (e) => {
  e.preventDefault(); // stay on the page instead of reloading
  const email = form.email.value.trim();
  // Basic shape check: something@something.something
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    msg.textContent = "Please enter a valid email address.";
    return;
  }
  // Placeholder: no backend yet, so nothing is sent or stored.
  msg.textContent = "Thanks! We'll be in touch.";
  form.reset();
});
