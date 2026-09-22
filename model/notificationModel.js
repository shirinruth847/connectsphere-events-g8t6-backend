const supabase = require('../config/supabase');

// Creates one notification and links it to each recipient (notification_recipient table).
async function createNotification({ eventId, title, message, type, recipientIds }) {
  const { data: notification, error } = await supabase
    .from('notification')
    .insert({ event_id: eventId, title, message, type })
    .select()
    .single();
  if (error) throw error;

  const recipients = recipientIds.map((recipientId) => ({
    notification_id: notification.notification_id,
    recipient_id: recipientId,
  }));
  const { error: recipientError } = await supabase.from('notification_recipient').insert(recipients);
  if (recipientError) throw recipientError;

  return notification;
}

module.exports = { createNotification };