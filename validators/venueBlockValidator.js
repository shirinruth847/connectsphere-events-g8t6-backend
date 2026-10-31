// Pure validation for operational blocks (SPM-195, Master 5.4.4, T4). Each
// validator returns the accepted values or { fields } with one message per
// rejected field. Unknown and server-controlled fields are refused.
const { MAX_INTEGER, parseDate } = require("./eventValidator");

const BLOCK_REASONS = Object.freeze(["MAINTENANCE", "EQUIPMENT_FAILURE", "RENOVATION", "SAFETY", "OTHER"]);
// The venue_calendar validator's limit on note.
const MAX_NOTE_LENGTH = 1000;
// A block is a set period; longer closures take the venue out of service (T33).
const MAX_BLOCK_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

const CREATE_FIELDS = new Set(["reason", "start", "end", "note"]);
const CHANGE_FIELDS = new Set(["start", "end", "version"]);
const LIFT_FIELDS = new Set(["version"]);

const BLOCK_MESSAGES = Object.freeze({
  reason: `Choose a reason: ${BLOCK_REASONS.join(", ")}.`,
  start: "Enter the start as an ISO 8601 date-time with a time zone offset.",
  end: "Enter the end as an ISO 8601 date-time with a time zone offset.",
  endBeforeStart: "The end must be after the start.",
  endInPast: "The end must be in the future.",
  tooLong: `A block can last at most ${MAX_BLOCK_DAYS} days. Take the venue out of service for longer closures.`,
  note: `Enter a note of 1 to ${MAX_NOTE_LENGTH} characters.`,
  version: "Reload the block, then try again.",
  extend: "Record a new block for additional time.",
  unknown: "This field cannot be set.",
});

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const rejectUnknown = (body, allowed, fields) => {
  Object.keys(body).filter((key) => !allowed.has(key)).forEach((key) => {
    fields[key] = BLOCK_MESSAGES.unknown;
  });
};

const hasFields = (fields) => Object.keys(fields).length > 0;

// start and end as Dates, end after start, at most MAX_BLOCK_DAYS apart.
const readInterval = (body, fields) => {
  const start = typeof body.start === "string" ? parseDate(body.start) : null;
  const end = typeof body.end === "string" ? parseDate(body.end) : null;
  if (!start) fields.start = BLOCK_MESSAGES.start;
  if (!end) fields.end = BLOCK_MESSAGES.end;
  if (start && end) {
    if (end <= start) fields.end = BLOCK_MESSAGES.endBeforeStart;
    else if (end - start > MAX_BLOCK_DAYS * DAY_MS) fields.end = BLOCK_MESSAGES.tooLong;
  }
  return { start, end };
};

const validateBlockCreate = (body, { now = new Date() } = {}) => {
  if (!isPlainObject(body)) return { fields: { body: "Send the block as a JSON object." } };
  const fields = {};
  rejectUnknown(body, CREATE_FIELDS, fields);

  if (!BLOCK_REASONS.includes(body.reason)) fields.reason = BLOCK_MESSAGES.reason;
  const { start, end } = readInterval(body, fields);
  if (end && !fields.end && end <= now) fields.end = BLOCK_MESSAGES.endInPast;
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note || note.length > MAX_NOTE_LENGTH) fields.note = BLOCK_MESSAGES.note;

  if (hasFields(fields)) return { fields };
  return { block: { reason: body.reason, start: start.toISOString(), end: end.toISOString(), note } };
};

const readVersion = (body, fields) => {
  const { version } = body;
  if (!Number.isInteger(version) || version < 1 || version > MAX_INTEGER) fields.version = BLOCK_MESSAGES.version;
  return version;
};

// Shortening sends the new start and end with the version it was loaded at.
const validateBlockChange = (body) => {
  if (!isPlainObject(body)) return { fields: { body: "Send the change as a JSON object." } };
  const fields = {};
  rejectUnknown(body, CHANGE_FIELDS, fields);
  const { start, end } = readInterval(body, fields);
  const version = readVersion(body, fields);
  if (hasFields(fields)) return { fields };
  return { change: { start: start.toISOString(), end: end.toISOString(), version } };
};

const validateBlockLift = (body) => {
  const input = body === undefined ? {} : body;
  if (!isPlainObject(input)) return { fields: { body: "Send the request as a JSON object." } };
  const fields = {};
  rejectUnknown(input, LIFT_FIELDS, fields);
  const version = readVersion(input, fields);
  if (hasFields(fields)) return { fields };
  return { lift: { version } };
};

// Block IDs are MongoDB ObjectIds; anything else cannot exist.
const parseBlockId = (value) => (typeof value === "string" && /^[0-9a-f]{24}$/.test(value) ? value : null);

module.exports = {
  BLOCK_REASONS,
  BLOCK_MESSAGES,
  MAX_NOTE_LENGTH,
  MAX_BLOCK_DAYS,
  validateBlockCreate,
  validateBlockChange,
  validateBlockLift,
  parseBlockId,
};
