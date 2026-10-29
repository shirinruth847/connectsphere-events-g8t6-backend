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

// ---------- booking request (SPM-179) ----------
// Returns { bookings } or { fields } keyed "bookings.<index>.<field>", so the
// form shows each error inside its own venue section (AC5). The database
// re-checks everything under the venue lock; these messages match it.

const MAX_BOOKINGS_PER_REQUEST = 10;
const BOOKING_LIMITS = Object.freeze({
  label: 100,
  layout: 50, // room.layout_type, which a bridging room copies (Master 6.2, T33)
  listItems: 20,
  listItemLength: 100,
  specialRequirements: 2000,
});
const BOOKING_ITEM_FIELDS = new Set([
  "venueId", "label", "start", "end", "expectedAttendance", "layout",
  "requiredFacilities", "accessibilityNeeds", "specialRequirements", "isPrimary",
]);
const BOOKING_MESSAGES = Object.freeze({
  venueRequired: "Venue is required.",
  venueTwice: "This venue is already in the request.",
  labelRequired: "Label is required.",
  labelTooLong: `Label must be ${BOOKING_LIMITS.label} characters or fewer.`,
  startRequired: "Start date and time is required.",
  endRequired: "End date and time is required.",
  timeInvalid: "Enter a date and time with a time zone, for example 2030-03-10T09:00:00+08:00.",
  endBeforeStart: "End time must be after start time.",
  startInPast: "The booking must start in the future.",
  outsideEvent: "The booking must be within the event's dates and times.",
  attendanceRequired: "Expected attendance is required.",
  attendanceInvalid: "Expected attendance must be a whole number of 1 or more.",
  layoutRequired: "Layout is required.",
  layoutTooLong: `Layout must be ${BOOKING_LIMITS.layout} characters or fewer.`,
  listInvalid: `List up to ${BOOKING_LIMITS.listItems} entries of ${BOOKING_LIMITS.listItemLength} characters or fewer.`,
  specialTooLong: `Special requirements must be ${BOOKING_LIMITS.specialRequirements} characters or fewer.`,
  primaryInvalid: "Primary venue must be true or false.",
  onePrimary: "Choose one primary venue.",
});

const isMissing = (value) => value === undefined || value === null || (typeof value === "string" && !value.trim());

const parseTextList = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > BOOKING_LIMITS.listItems) return null;
  const items = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || item.trim().length > BOOKING_LIMITS.listItemLength) return null;
    if (!items.includes(item.trim())) items.push(item.trim());
  }
  return items;
};

// A booking's window: both times readable (with a time zone), the end after the
// start, a start in the future and the window within the event (Master 6.3).
// Returns the parsed times and the error for each field that has one.
const readBookingTimes = (item, { eventStart, eventEnd, now }) => {
  const start = parseDate(item.start);
  const end = parseDate(item.end);
  const errors = {};
  // A value that is present but unreadable (e.g. no time zone) is not "missing".
  if (!start) errors.start = isMissing(item.start) ? BOOKING_MESSAGES.startRequired : BOOKING_MESSAGES.timeInvalid;
  if (!end) errors.end = isMissing(item.end) ? BOOKING_MESSAGES.endRequired : BOOKING_MESSAGES.timeInvalid;
  if (start && end) {
    if (end <= start) errors.end = BOOKING_MESSAGES.endBeforeStart;
    else if (start <= now) errors.start = BOOKING_MESSAGES.startInPast;
    else if (eventStart && eventEnd && (start < eventStart || end > eventEnd)) errors.start = BOOKING_MESSAGES.outsideEvent;
  }
  return { start, end, errors };
};

// One venue section. Errors go into context.fields under "bookings.<index>.<field>";
// context.seenVenues refuses a venue listed twice. Returns the normalised booking,
// or null when the section is not an object.
const validateBookingItem = (item, index, context) => {
  const { fields, seenVenues } = context;
  const at = (field) => `bookings.${index}.${field}`;
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    fields[`bookings.${index}`] = "Each venue must be an object.";
    return null;
  }
  for (const key of Object.keys(item)) {
    if (!BOOKING_ITEM_FIELDS.has(key)) fields[at(key.slice(0, 60))] = "This field cannot be set.";
  }

  const venueId = Number.isInteger(item.venueId) && item.venueId > 0 && item.venueId <= MAX_INTEGER ? item.venueId : null;
  if (!venueId) fields[at("venueId")] = BOOKING_MESSAGES.venueRequired;
  else if (seenVenues.has(venueId)) fields[at("venueId")] = BOOKING_MESSAGES.venueTwice;
  else seenVenues.add(venueId);

  const label = typeof item.label === "string" ? item.label.trim() : "";
  if (!label) fields[at("label")] = BOOKING_MESSAGES.labelRequired;
  else if (label.length > BOOKING_LIMITS.label) fields[at("label")] = BOOKING_MESSAGES.labelTooLong;

  const { start, end, errors: timeErrors } = readBookingTimes(item, context);
  for (const [field, message] of Object.entries(timeErrors)) fields[at(field)] = message;

  const attendance = item.expectedAttendance;
  if (isMissing(attendance)) fields[at("expectedAttendance")] = BOOKING_MESSAGES.attendanceRequired;
  else if (!Number.isInteger(attendance) || attendance < 1 || attendance > MAX_INTEGER) {
    fields[at("expectedAttendance")] = BOOKING_MESSAGES.attendanceInvalid;
  }

  const layout = typeof item.layout === "string" ? item.layout.trim() : "";
  if (!layout) fields[at("layout")] = BOOKING_MESSAGES.layoutRequired;
  else if (layout.length > BOOKING_LIMITS.layout) fields[at("layout")] = BOOKING_MESSAGES.layoutTooLong;

  const requiredFacilities = parseTextList(item.requiredFacilities);
  if (!requiredFacilities) fields[at("requiredFacilities")] = BOOKING_MESSAGES.listInvalid;
  const accessibilityNeeds = parseTextList(item.accessibilityNeeds);
  if (!accessibilityNeeds) fields[at("accessibilityNeeds")] = BOOKING_MESSAGES.listInvalid;

  let specialRequirements = null;
  if (item.specialRequirements !== undefined && item.specialRequirements !== null) {
    if (typeof item.specialRequirements !== "string" || item.specialRequirements.trim().length > BOOKING_LIMITS.specialRequirements) {
      fields[at("specialRequirements")] = BOOKING_MESSAGES.specialTooLong;
    } else {
      specialRequirements = item.specialRequirements.trim() || null;
    }
  }

  if (item.isPrimary !== undefined && typeof item.isPrimary !== "boolean") fields[at("isPrimary")] = BOOKING_MESSAGES.primaryInvalid;

  return {
    venueId,
    label,
    start: start ? start.toISOString() : null,
    end: end ? end.toISOString() : null,
    expectedAttendance: attendance,
    layout,
    requiredFacilities: requiredFacilities || [],
    accessibilityNeeds: accessibilityNeeds || [],
    specialRequirements,
    isPrimary: item.isPrimary === true,
  };
};

// event: the visible event row (start_datetime, end_datetime); now: injectable for tests.
const validateVenueBookingRequest = (body, { event, now = new Date() } = {}) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { fields: { body: "Send a JSON object with a bookings list." } };
  }
  const fields = {};
  for (const key of Object.keys(body)) {
    if (key !== "bookings") fields[key.slice(0, 60)] = "This field cannot be set.";
  }
  const list = body.bookings;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BOOKINGS_PER_REQUEST) {
    fields.bookings = `Add between 1 and ${MAX_BOOKINGS_PER_REQUEST} venues.`;
    return { fields };
  }

  const context = {
    fields,
    seenVenues: new Set(),
    eventStart: event?.start_datetime ? new Date(event.start_datetime) : null,
    eventEnd: event?.end_datetime ? new Date(event.end_datetime) : null,
    now,
  };
  const bookings = list.map((item, index) => validateBookingItem(item, index, context));
  if (bookings.filter((booking) => booking?.isPrimary).length > 1) fields["bookings.primary"] = BOOKING_MESSAGES.onePrimary;

  return Object.keys(fields).length ? { fields } : { bookings };
};

module.exports = {
  validateVenueBookingRequest,
  MAX_BOOKINGS_PER_REQUEST,
  BOOKING_LIMITS,
  BOOKING_MESSAGES,
  parseBookingFilters,
  parseId,
  VENUE_BOOKING_STATUSES,
  BOOKING_SORTS,
  SORT_ORDERS,
  MAX_SEARCH_LENGTH,
  BOOKING_LIST_LIMIT_DEFAULT,
  BOOKING_LIST_LIMIT_MAX,
};
