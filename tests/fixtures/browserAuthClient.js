const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// Signs in the way the frontend does: straight to Supabase Auth, not through
// Express. Uses the anon/publishable key when configured, like the browser.
const createBrowserAuthClient = () => createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
);

// Returns { session, error } without throwing so tests can assert on errors.
const signInWithPassword = async (email, password) => {
  const { data, error } = await createBrowserAuthClient().auth.signInWithPassword({ email, password });
  return { session: data ? data.session : null, error };
};

module.exports = { createBrowserAuthClient, signInWithPassword };
