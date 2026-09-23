const supabase = require('../config/supabase');

async function findUserByEmail(email) {
  const { data, error } = await supabase
    .from('user')
    .select('user_id, email, name, role')
    .eq('email', email)
    .maybeSingle();
  if (error) throw error;
  return data;
}

module.exports = { findUserByEmail };