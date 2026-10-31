// Values must match the public.notification_type enum exactly.
const NOTIFICATION_TYPES = Object.freeze({
  STATUS_CHANGE: "STATUS_CHANGE",
  BOOKING_UPDATE: "BOOKING_UPDATE",
  EQUIPMENT_UPDATE: "EQUIPMENT_UPDATE",
  REGISTRATION_ALERT: "REGISTRATION_ALERT",
  REGISTRATION_CONFIRMED: "REGISTRATION_CONFIRMED",
  WAITLIST_JOINED: "WAITLIST_JOINED",
  WAITLIST_OFFER: "WAITLIST_OFFER",
  EVENT_CANCELLED: "EVENT_CANCELLED",
  EVENT_CHANGED: "EVENT_CHANGED",
  EVENT_REMINDER: "EVENT_REMINDER",
  VENUE_SUGGESTION: "VENUE_SUGGESTION",
  ASSIGNMENT_ENDED: "ASSIGNMENT_ENDED",
});

// Where "Go to Event" leads. The frontend maps each page to its URL: My Events
// for attendees (SPM-155 AC4, AC5), the event workspace for everyone else.
const NOTIFICATION_TARGET_PAGES = Object.freeze({
  MY_EVENTS: "MY_EVENTS",
  EVENT_WORKSPACE: "EVENT_WORKSPACE",
  // Technical Support open the request itself; the target then also carries
  // technical_request_id (SPM-196).
  TECHNICAL_REQUESTS: "TECHNICAL_REQUESTS",
});

module.exports = { NOTIFICATION_TYPES, NOTIFICATION_TARGET_PAGES };
