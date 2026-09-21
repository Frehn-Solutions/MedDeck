// The browser's single connection to Supabase, plus the sign-up / log-in / log-out helpers.
// Every page that talks to Supabase imports from here, so they all share one client and one login session.

// Loaded after /config.js and /vendor/supabase.js, which provide the globals used below.
// (config.js sets window.MEDDECK_CONFIG; the vendor bundle sets window.supabase.)
const { supabaseUrl, supabaseAnonKey } = window.MEDDECK_CONFIG || {};

// Pages check this first so they can show a friendly message if the server has no Supabase settings.
export const isConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// The anon key is safe in the browser: what each user can actually do is limited by Row Level Security in Supabase.
export const supabase = isConfigured ? window.supabase.createClient(supabaseUrl, supabaseAnonKey) : null;

// Returns the client, or throws a clear error if Supabase isn't configured.
function client() {
  if (!supabase) throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.");
  return supabase;
}

// Create an account. `metadata` (e.g. { full_name }) is stored on the user.
// If email confirmation is on, Supabase emails a link that returns to this site's home page.
export async function signUp(email, password, metadata = {}) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: { data: metadata, emailRedirectTo: `${window.location.origin}/` },
  });
  if (error) throw error;
  return data;
}

// Sign in with email and password. Supabase stores the session in the browser, so it survives page reloads.
export async function logIn(email, password) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

// End the session. Pages listen for the SIGNED_OUT event and redirect accordingly.
export async function logOut() {
  const { error } = await client().auth.signOut();
  if (error) throw error;
}
