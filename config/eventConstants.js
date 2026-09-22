// Shared constants for event requests. Values must match the Postgres enums exactly.
const EVENT_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
});

const USER_ROLES = Object.freeze({
  ORGANISER: 'ORGANISER',
  COORDINATOR: 'COORDINATOR',
});

const NOTIFICATION_TYPES = Object.freeze({
  STATUS_CHANGE: 'STATUS_CHANGE',
});

// What the frontend shows for each stored status (AC: dashboard shows "Pending Approval").
const STATUS_LABELS = Object.freeze({
  DRAFT: 'Draft',
  SUBMITTED: 'Pending Approval',
});

const NO_LAYOUT_PREFERENCE = 'NO_PREFERENCE';
const MIN_LEAD_TIME_HOURS = 48;

module.exports = {
  EVENT_STATUS,
  USER_ROLES,
  NOTIFICATION_TYPES,
  STATUS_LABELS,
  NO_LAYOUT_PREFERENCE,
  MIN_LEAD_TIME_HOURS,
};
