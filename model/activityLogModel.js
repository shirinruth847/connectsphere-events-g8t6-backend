const supabase = require('../config/supabase');

async function logActivity({ userId, entityName, entityId, action, details }) {
  const { error } = await supabase.from('activity_log').insert({
    user_id: userId,
    entity_name: entityName,
    entity_id: entityId,
    action,
    details,
  });
  if (error) throw error;
}

module.exports = { logActivity };