const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase environment variables in .env');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Password sign-in stores the resulting session on the client, so each sign-in
// gets a throwaway client instead of mutating the shared one.
const createSessionClient = () => createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

module.exports = supabase;
module.exports.createSessionClient = createSessionClient;
