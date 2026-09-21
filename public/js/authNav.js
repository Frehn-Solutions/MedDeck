// Fills the <div id="auth-nav"> in the page header with the right buttons for the current login state.
// Signed out: "Log in" and "Sign up". Signed in: the user's email, "My materials" and "Log out".
import { isConfigured, logOut, supabase } from "./supabaseClient.js";

const nav = document.getElementById("auth-nav");

// Redraw the nav for the given session (null when signed out).
function render(session) {
  nav.replaceChildren();

  if (session) {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = session.user.email; // textContent, never innerHTML, so it can't inject markup

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-small btn-ghost";
    button.textContent = "Log out";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await logOut(); // the auth listener below then redraws the nav as signed out
      } catch {
        button.disabled = false;
      }
    });

    // No need to link to the portal from the portal itself.
    if (!window.location.pathname.endsWith("/portal.html")) {
      const portal = document.createElement("a");
      portal.className = "btn btn-small";
      portal.href = "portal.html";
      portal.textContent = "My materials";
      nav.append(portal);
    }
    nav.prepend(who);
    nav.append(button);
  } else {
    const login = document.createElement("a");
    login.className = "btn btn-small btn-ghost";
    login.href = "login.html";
    login.textContent = "Log in";

    const signup = document.createElement("a");
    signup.className = "btn btn-small";
    signup.href = "signup.html";
    signup.textContent = "Sign up";

    nav.append(login, signup);
  }
  // The nav is hidden by CSS until this attribute exists, which avoids flashing the wrong buttons on load.
  nav.dataset.ready = "";
}

if (isConfigured) {
  // Redraw whenever the login state changes (sign in, sign out, token refresh) and once on page load.
  supabase.auth.onAuthStateChange((_event, session) => render(session));
  supabase.auth.getSession().then(({ data }) => render(data.session));
} else {
  render(null);
}
