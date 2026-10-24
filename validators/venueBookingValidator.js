// Pure validation for the Venue Staff booking review (SPM-181). Returns
// { filters } or { fields } with one message per rejected query parameter.
const { MAX_INTEGER, parseDate } = require("./eventValidator");

// Values of the live public.booking_status enum. Master section 5.4 also names
// HELD, EXPIRED and RELEASED; they join this list when the schema adds them.
const VENUE_BOOKING_STATUSES = Object.freeze(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]);

const BOOKING_LIST_LIMIT_DEFAULT = 100;
const BOOKING_LIST_LIMIT_MAX = 200;
const MAX_DATE_RANGE_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

const FILTER_PARAMS = new Set(["status", "venueId", "eventId", "from", "to", "limit", "q", "sort", "order"]);

// My Requests sorts (SPM-181). "default" puts pending requests first, then the
// soonest booking; "lastOpened" is per viewer and sorted by the browser.
const BOOKING_SORTS = Object.freeze(["default", "date", "attendance", "lastEdited", "alphabetical"]);
const SORT_ORDERS = Object.freeze(["asc", "desc"]);
const MAX_SEARCH_LENGTH = 100;

const parseId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= MAX_INTEGER ? Number(value) : null;

// One value per parameter: Express turns ?status=A&status=B into an array.
const single = (value) => (Array.isArray(value) ? null : value);

const parseBookingFilters = (query) => {
  const fields = {};
  const filters = {
    status: null, venueId: null, eventId: null, from: null, to: null, limit: BOOKING_LIST_LIMIT_DEFAULT,
    q: null, sort: "default", order: "asc",
  };

  for (const key of Object.keys(query)) {
    if (!FILTER_PARAMS.has(key)) fields[key] = "This filter is not supported.";
  }

  if (query.status !== undefined) {
    const status = single(query.status);
    if (VENUE_BOOKING_STATUSES.includes(status)) filters.status = status;
    else fields.status = `Status must be one of ${VENUE_BOOKING_STATUSES.join(", ")}.`;
  }

  for (const key of ["venueId", "eventId"]) {
    if (query[key] === undefined) continue;
    const id = parseId(single(query[key]));
    if (id) filters[key] = id;
    else fields[key] = "Choose a valid ID.";
  }

  // A date filter is the viewer's local day, sent as an instant range so the
  // server never guesses the viewer's time zone.
  if (query.from !== undefined || query.to !== undefined) {
    const from = parseDate(single(query.from));
    const to = parseDate(single(query.to));
    if (!from || !to) {
      fields.date = "Provide both from and to as ISO 8601 date-times with a time zone offset.";
    } else if (to <= from || to - from > MAX_DATE_RANGE_DAYS * DAY_MS) {
      fields.date = `The date range must end after it starts and span at most ${MAX_DATE_RANGE_DAYS} days.`;
    } else {
      filters.from = from.toISOString();
      filters.to = to.toISOString();
    }
  }

  if (query.limit !== undefined) {
    const limit = parseId(single(query.limit));
    if (limit && limit <= BOOKING_LIST_LIMIT_MAX) filters.limit = limit;
    else fields.limit = `Limit must be a whole number from 1 to ${BOOKING_LIST_LIMIT_MAX}.`;
  }

  if (query.q !== undefined) {
    const text = single(query.q);
    if (typeof text !== "string" || text.trim().length > MAX_SEARCH_LENGTH) {
      fields.q = `Search must be text of ${MAX_SEARCH_LENGTH} characters or fewer.`;
    } else if (text.trim()) {
      filters.q = text.trim();
    }
  }
  if (query.sort !== undefined) {
    const sort = single(query.sort);
    if (BOOKING_SORTS.includes(sort)) filters.sort = sort;
    else fields.sort = `Sort must be one of ${BOOKING_SORTS.join(", ")}.`;
  }
  if (query.order !== undefined) {
    const order = single(query.order);
    if (SORT_ORDERS.includes(order)) filters.order = order;
    else fields.order = "Order must be asc or desc.";
  }

  return Object.keys(fields).length ? { fields } : { filters };
};

// Venue Staff decisions (SPM-186, SPM-189). The status the user saw is sent
// back so a decision made from a stale screen is refused (SPM-186 AC5).
const MAX_REJECTION_REASON_LENGTH = 1000;
const DECISION_MESSAGES = Object.freeze({
  reasonRequired: "Enter a reason for rejecting this booking.",
  reasonTooLong: `The reason must be ${MAX_REJECTION_REASON_LENGTH} characters or fewer.`,
  expectedStatusInvalid: "Reload the booking, then try again.",
  unknownField: "This field is not supported.",
  bodyInvalid: "Send the decision as a JSON object.",
});
const DECIDABLE_STATUSES = Object.freeze({ approve: ["PENDING"], reject: ["PENDING", "APPROVED"] });

const parseBookingDecision = (body, decision) => {
  const input = body === undefined || body === null ? {} : body;
  if (typeof input !== "object" || Array.isArray(input)) return { fields: { body: DECISION_MESSAGES.bodyInvalid } };

  const allowed = decision === "reject" ? ["reason", "expectedStatus"] : ["expectedStatus"];
  const fields = {};
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) fields[key] = DECISION_MESSAGES.unknownField;
  }

  const values = { expectedStatus: null, reason: null };
  if (input.expectedStatus !== undefined || decision === "reject") {
    if (DECIDABLE_STATUSES[decision].includes(input.expectedStatus)) values.expectedStatus = input.expectedStatus;
    else fields.expectedStatus = DECISION_MESSAGES.expectedStatusInvalid;
  }

  if (decision === "reject") {
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (!reason) fields.reason = DECISION_MESSAGES.reasonRequired;
    else if (reason.length > MAX_REJECTION_REASON_LENGTH) fields.reason = DECISION_MESSAGES.reasonTooLong;
    else values.reason = reason;
  }

  return Object.keys(fields).length ? { fields } : { values };
};

module.exports = {
  parseBookingFilters,
  parseBookingDecision,
  DECISION_MESSAGES,
  MAX_REJECTION_REASON_LENGTH,
  parseId,
  VENUE_BOOKING_STATUSES,
  BOOKING_SORTS,
  SORT_ORDERS,
  MAX_SEARCH_LENGTH,
  BOOKING_LIST_LIMIT_DEFAULT,
  BOOKING_LIST_LIMIT_MAX,
};
