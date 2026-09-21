document.getElementById("year").textContent = new Date().getFullYear();

const form = document.querySelector(".signup");
const msg = document.querySelector(".form-msg");

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = form.email.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    msg.textContent = "Please enter a valid email address.";
    return;
  }
  // Placeholder: no backend yet, so nothing is sent or stored.
  msg.textContent = "Thanks! We'll be in touch.";
  form.reset();
});
