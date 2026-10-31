// The signed-in user's inbox and read state (SPM-156), and the reminder batch
// (SPM-158). Notifications are never written from here: database functions
// write them inside the transaction of the action that causes them (Master 8).
// Which notifications a user may see is decided once, in the database
// (_notification_visible), so the list, the count and both read actions agree.
const supabase = require("../config/supabase");
const { USER_ROLES } = require("../config/roles");
const { NOTIFICATION_TARGET_PAGES } = require("../config/notificationConstants");
const { isValidCursorTimestamp } = require("./eventModel");

const notificationError = (code) => {
  const error = new Error(code);
  error.name = "NotificationError";
  error.code = code;
  return error;
};

const dbError = (error) => new Error(`[Supabase Error] ${error.message}`);

// Keyset on (created_at, notification_id), newest first. created_at keeps the
// exact PostgREST text so microseconds survive the round trip.
const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ createdAt: row.created_at, notificationId: row.notification_id })).toString("base64url");

const decodeCursor = (value) => {
  if (value === undefined || value === null) return null;
  let decoded = null;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    decoded = null;
  }
  if (
    !decoded ||
    !isValidCursorTimestamp(decoded.createdAt) ||
    !Number.isSafeInteger(decoded.notificationId) ||
    decoded.notificationId < 1
  ) {
    throw notificationError("INVALID_CURSOR");
  }
  return decoded;
};

const TARGET_PAGE_BY_ROLE = Object.freeze({
  [USER_ROLES.ATTENDEE]: NOTIFICATION_TARGET_PAGES.MY_EVENTS,
  [USER_ROLES.TECH_SUPPORT]: NOTIFICATION_TARGET_PAGES.TECHNICAL_REQUESTS,
  [USER_ROLES.VENUE_STAFF]: NOTIFICATION_TARGET_PAGES.VENUE_BOOKING_REQUESTS,
});

const targetPageFor = (role) => TARGET_PAGE_BY_ROLE[role] ?? NOTIFICATION_TARGET_PAGES.EVENT_WORKSPACE;

// Only the reader's own copy: no other recipients, no staff-only fields.
// A Technical Support notice also names its request, and a Venue Staff booking
// request notice its booking, so Go to Event opens it.
const toNotificationItem = (row, role) => ({
  notification_id: row.notification_id,
  type: row.type,
  title: row.title,
  message: row.message,
  created_at: row.created_at,
  is_read: row.is_read,
  read_at: row.read_at,
  action_expires_at: row.action_expires_at,
  event: row.event_id ? { event_id: row.event_id, title: row.event_title } : null,
  target: row.event_id
    ? {
        page: targetPageFor(role),
        event_id: row.event_id,
        ...(row.technical_request_id ? { technical_request_id: row.technical_request_id } : {}),
        ...(row.booking_id ? { booking_id: row.booking_id } : {}),
      }
    : null,
});

// The record a role's notice opens, read from the action key the database
// writes: "TECHNICAL_REQUEST_SENT:<technical_request_id>" for Technical Support,
// "VENUE_BOOKINGS_REQUESTED:<event_id>:<first booking_id>" for Venue Staff (SPM-179).
const TARGET_ACTION_KEYS = Object.freeze({
  [USER_ROLES.TECH_SUPPORT]: { field: "technical_request_id", pattern: /^TECHNICAL_REQUEST_SENT:([1-9]\d*)$/ },
  [USER_ROLES.VENUE_STAFF]: { field: "booking_id", pattern: /^VENUE_BOOKINGS_REQUESTED:[1-9]\d*:([1-9]\d*)$/ },
});

// notification_id -> { [field]: id } for the notices that name one.
const findTargetIds = async (role, notificationIds) => {
  const target = TARGET_ACTION_KEYS[role];
  if (!target || !notificationIds.length) return new Map();
  const { data, error } = await supabase
    .from("notification")
    .select("notification_id,action_key")
    .in("notification_id", notificationIds);
  if (error) throw dbError(error);
  const ids = new Map();
  for (const { notification_id: notificationId, action_key: actionKey } of data) {
    const match = target.pattern.exec(actionKey ?? "");
    if (match) ids.set(notificationId, { [target.field]: Number(match[1]) });
  }
  return ids;
};

const findNotifications = async (user, { limit, cursor = null }) => {
  const before = decodeCursor(cursor);
  const { data, error } = await supabase.rpc("list_notifications", {
    p_user_id: user.user_id,
    p_limit: limit + 1,
    p_before_created_at: before ? before.createdAt : null,
    p_before_id: before ? before.notificationId : null,
  });
  if (error) throw dbError(error);

  const page = data.slice(0, limit);
  const targetIds = await findTargetIds(user.role, page.map((row) => row.notification_id));
  return {
    notifications: page.map((row) => toNotificationItem({ ...row, ...targetIds.get(row.notification_id) }, user.role)),
    nextCursor: data.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
};

const countUnreadNotifications = async (userId) => {
  const { data, error } = await supabase.rpc("count_unread_notifications", { p_user_id: userId });
  if (error) throw dbError(error);
  return data;
};

// Null when the notification is not the user's or is hidden from them.
const markNotificationRead = async (userId, notificationId) => {
  const { data, error } = await supabase.rpc("mark_notification_read", {
    p_user_id: userId,
    p_notification_id: notificationId,
  });
  if (error) throw dbError(error);
  return data[0] || null;
};

const markAllNotificationsRead = async (userId) => {
  const { data, error } = await supabase.rpc("mark_all_notifications_read", { p_user_id: userId });
  if (error) throw dbError(error);
  return data;
};

// One bounded reminder batch (SPM-158); returns how many reminders were sent.
const sendDueEventReminders = async (limit) => {
  const { data, error } = await supabase.rpc("send_due_event_reminders", { p_limit: limit });
  if (error) throw dbError(error);
  return data;
};

module.exports = {
  findNotifications,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  sendDueEventReminders,
  toNotificationItem,
  encodeCursor,
  decodeCursor,
};
