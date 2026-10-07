// Values must match the public.event_status enum exactly (Master section 5.2).
const EVENT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  AWAITING_CLARIFICATION: "AWAITING_CLARIFICATION",
  PLANNING: "PLANNING",
  CONFIRMED: "CONFIRMED",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});

const USER_ROLES = Object.freeze({
  ORGANISER: "ORGANISER",
  COORDINATOR: "COORDINATOR",
  COORDINATOR_LEAD: "COORDINATOR_LEAD",
});

const NOTIFICATION_TYPES = Object.freeze({
  STATUS_CHANGE: "STATUS_CHANGE",
});

// What the frontend shows for each stored status (SPM-35: dashboard shows "Pending Approval").
const STATUS_LABELS = Object.freeze({
  DRAFT: "Draft",
  SUBMITTED: "Pending Approval",
});

const NO_LAYOUT_PREFERENCE = "NO_PREFERENCE";
const MIN_LEAD_TIME_HOURS = 48;

module.exports = {
  EVENT_STATUS,
  STATUS_LABELS,
  NO_LAYOUT_PREFERENCE,
  MIN_LEAD_TIME_HOURS,
};
