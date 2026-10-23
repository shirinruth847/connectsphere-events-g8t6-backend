const { MAX_INTEGER } = require("../validators/eventValidator");

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 100;
const PAGE_OFFSET_MAX = 10000;
const PAGE_CURSOR = /^[A-Za-z0-9_-]{1,256}$/;

const parseWholeNumber = (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN);

const parseLimit = (limit, pagination, fields) => {
  if (limit === undefined) {
    return;
  }
  const value = parseWholeNumber(limit);
  if (value >= 1 && value <= PAGE_LIMIT_MAX) {
    pagination.limit = value;
  } else {
    fields.limit = `Limit must be a whole number from 1 to ${PAGE_LIMIT_MAX}.`;
  }
};

const rejectFields = (res, fields) =>
  res.status(400).json({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });

// Bounds list queries. The parsed values go on req.pagination because
// req.query is read-only in Express 5.
const validatePagination = (req, res, next) => {
  const { limit, offset } = req.query;
  const pagination = { limit: PAGE_LIMIT_DEFAULT, offset: 0 };
  const fields = {};

  parseLimit(limit, pagination, fields);

  if (offset !== undefined) {
    const value = parseWholeNumber(offset);
    if (value >= 0 && value <= PAGE_OFFSET_MAX) {
      pagination.offset = value;
    } else {
      fields.offset = `Offset must be a whole number from 0 to ${PAGE_OFFSET_MAX}.`;
    }
  }

  if (Object.keys(fields).length > 0) {
    return rejectFields(res, fields);
  }

  req.pagination = pagination;
  return next();
};

// For lists ordered by a column that changes (e.g. updated_at), where offset pages
// would skip or repeat rows. The cursor is opaque here; the model decodes it.
const validateCursorPagination = (req, res, next) => {
  const { limit, cursor, offset } = req.query;
  const pagination = { limit: PAGE_LIMIT_DEFAULT, cursor: null };
  const fields = {};

  parseLimit(limit, pagination, fields);

  if (cursor !== undefined) {
    if (typeof cursor === "string" && PAGE_CURSOR.test(cursor)) {
      pagination.cursor = cursor;
    } else {
      fields.cursor = "Invalid page cursor.";
    }
  }
  // Rejected rather than ignored, so an offset-based client cannot loop on page one.
  if (offset !== undefined) {
    fields.offset = "This list uses cursor paging. Pass nextCursor as cursor instead of offset.";
  }

  if (Object.keys(fields).length > 0) {
    return rejectFields(res, fields);
  }

  req.pagination = pagination;
  return next();
};

// Returns the numeric ID, or null for anything that cannot be an event ID. IDs
// that cannot exist are "not found", like IDs the user may not see.
const parseEventId = (value) =>
  /^[1-9]\d{0,9}$/.test(value) && Number(value) <= MAX_INTEGER ? Number(value) : null;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const IDEMPOTENCY_KEY_MESSAGE =
  "Send an Idempotency-Key header of 8-128 letters, digits, '.', '_', ':' or '-' (a UUID works).";

// The request's Idempotency-Key header, or null when absent or malformed.
const readIdempotencyKey = (req) => {
  const key = req.get("Idempotency-Key");
  return typeof key === "string" && IDEMPOTENCY_KEY.test(key) ? key : null;
};

module.exports = {
  validatePagination,
  validateCursorPagination,
  parseEventId,
  readIdempotencyKey,
  IDEMPOTENCY_KEY_MESSAGE,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  PAGE_OFFSET_MAX,
};
