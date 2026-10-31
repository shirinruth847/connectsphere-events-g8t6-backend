// Pure validation for tentative holds (SPM-190, Master 5.4.3). Each validator
// returns the accepted values or { fields } with one message per rejected
// field. Unknown and server-controlled fields (expiry, status) are refused.
const { MAX_INTEGER, parseDate } = require("./eventValidator");

const MAX_LABEL_LENGTH = 100;
const MAX_NOTE_LENGTH = 500;
const MAX_REASON_LENGTH = 1000;
const MAX_EXTENSION_DAYS = 7;
const HOLD_ID = /^[0-9a-f]{24}$/;

const REQUEST_FIELDS = new Set(["venueId", "label", "start", "end", "expectedAttendance", "note"]);

const HOLD_MESSAGES = Object.freeze({
  venueId: "Choose a venue.",
  label: `Enter a label of 1 to ${MAX_LABEL_LENGTH} characters.`,
  start: "Enter the start as an ISO 8601 date-time with a time zone offset.",
  end: "Enter the end as an ISO 8601 date-time with a time zone offset.",
  endBeforeStart: "The end must be after the start.",
  startInPast: "The start must be in the future.",
  outsideEvent: "Must be within the event's dates and times.",
  attendance: "Enter a whole number of people, at least 1.",
  note: `The note must be ${MAX_NOTE_LENGTH} characters or fewer.`,
  reason: `Enter a reason of 1 to ${MAX_REASON_LENGTH} characters.`,
  days: `Extend by a whole number of days from 1 to ${MAX_EXTENSION_DAYS}.`,
  unknown: "This field cannot be set.",
});

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasFields = (fields) => Object.keys(fields).length > 0;
const onlyFields = (body, allowed, fields) => {
  Object.keys(body).filter((key) => !allowed.has(key)).forEach((key) => {
    fields[key.slice(0, 60)] = HOLD_MESSAGES.unknown;
  });
};

// POST /api/events/:id/venue-holds/requests. event: the visible event row.
const validateHoldRequest = (body, { event, now = new Date() } = {}) => {
  if (!isPlainObject(body)) return { fields: { body: "Send the hold request as a JSON object." } };
  const fields = {};
  onlyFields(body, REQUEST_FIELDS, fields);

  const venueId = body.venueId;
  if (!Number.isInteger(venueId) || venueId < 1 || venueId > MAX_INTEGER) fields.venueId = HOLD_MESSAGES.venueId;

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > MAX_LABEL_LENGTH) fields.label = HOLD_MESSAGES.label;

  const start = typeof body.start === "string" ? parseDate(body.start) : null;
  const end = typeof body.end === "string" ? parseDate(body.end) : null;
  if (!start) fields.start = HOLD_MESSAGES.start;
  if (!end) fields.end = HOLD_MESSAGES.end;
  if (start && end) {
    const eventStart = event?.start_datetime ? new Date(event.start_datetime) : null;
    const eventEnd = event?.end_datetime ? new Date(event.end_datetime) : null;
    if (end <= start) fields.end = HOLD_MESSAGES.endBeforeStart;
    else if (start <= now) fields.start = HOLD_MESSAGES.startInPast;
    else if (eventStart && eventEnd && (start < eventStart || end > eventEnd)) fields.start = HOLD_MESSAGES.outsideEvent;
  }

  let expectedAttendance = null;
  if (body.expectedAttendance !== undefined && body.expectedAttendance !== null) {
    if (!Number.isInteger(body.expectedAttendance) || body.expectedAttendance < 1 || body.expectedAttendance > MAX_INTEGER) {
      fields.expectedAttendance = HOLD_MESSAGES.attendance;
    } else {
      expectedAttendance = body.expectedAttendance;
    }
  }

  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.trim().length > MAX_NOTE_LENGTH) fields.note = HOLD_MESSAGES.note;
    else note = body.note.trim() || null;
  }

  if (hasFields(fields)) return { fields };
  return { values: { venueId, label, start: start.toISOString(), end: end.toISOString(), expectedAttendance, note } };
};

// POST /api/venues/hold-requests/:requestId/decline
const validateHoldDecline = (body) => {
  if (!isPlainObject(body)) return { fields: { body: "Send the decision as a JSON object." } };
  const fields = {};
  onlyFields(body, new Set(["reason"]), fields);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > MAX_REASON_LENGTH) fields.reason = HOLD_MESSAGES.reason;
  return hasFields(fields) ? { fields } : { values: { reason } };
};

// POST /api/venues/holds/:holdId/extend
const validateHoldExtension = (body) => {
  if (!isPlainObject(body)) return { fields: { body: "Send the extension as a JSON object." } };
  const fields = {};
  onlyFields(body, new Set(["days"]), fields);
  if (!Number.isInteger(body.days) || body.days < 1 || body.days > MAX_EXTENSION_DAYS) fields.days = HOLD_MESSAGES.days;
  return hasFields(fields) ? { fields } : { values: { days: body.days } };
};

// Bodiless actions (place, withdraw, release) take no fields at all.
const validateEmptyBody = (body) => {
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) return { fields: { body: "Send no body, or an empty JSON object." } };
  const fields = {};
  onlyFields(body, new Set(), fields);
  return hasFields(fields) ? { fields } : {};
};

const parseHoldId = (value) => (typeof value === "string" && HOLD_ID.test(value) ? value : null);

module.exports = {
  validateHoldRequest,
  validateHoldDecline,
  validateHoldExtension,
  validateEmptyBody,
  parseHoldId,
  HOLD_MESSAGES,
  MAX_EXTENSION_DAYS,
};
