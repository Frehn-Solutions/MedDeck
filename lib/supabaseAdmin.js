const { createClient } = require("@supabase/supabase-js");

// Cached so the whole server shares one client instead of creating one per request.
let client;

// Service-role client: bypasses RLS, so it must only ever be used server-side.
function getAdmin() {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY and SUPABASE_URL must be set.");
  // No session handling: this client acts as the server itself, not as any particular signed-in user.
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

module.exports = { getAdmin };
