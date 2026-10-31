// GET /api/venues/availability (SPM-74). Pure; returns { query } or { fields }.
const { parseDate } = require("./eventValidator");
const { parseId } = require("./venueBookingValidator");

// A year, so the calendar's year view loads in one request.
const MAX_RANGE_DAYS = 366;
const MAX_VENUES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const PARAMS = new Set(["from", "to", "venueId", "checkStart", "checkEnd"]);
const DATE_MESSAGE = "Use an ISO 8601 date-time with a time zone offset, for example 2026-11-04T09:00:00+08:00.";

const validateAvailabilityQuery = (query) => {
  const fields = {};
  for (const key of Object.keys(query)) {
    if (!PARAMS.has(key)) fields[key] = "This parameter is not supported.";
  }

  const from = parseDate(Array.isArray(query.from) ? null : query.from);
  const to = parseDate(Array.isArray(query.to) ? null : query.to);
  if (!from) fields.from = DATE_MESSAGE;
  if (!to) fields.to = DATE_MESSAGE;
  if (from && to && (to <= from || to - from > MAX_RANGE_DAYS * DAY_MS)) {
    fields.to = `The date range must end after it starts and span at most ${MAX_RANGE_DAYS} days.`;
  }

  // ?venueId=1&venueId=2 or ?venueId=1,2
  let venueIds = [];
  if (query.venueId !== undefined) {
    const raw = (Array.isArray(query.venueId) ? query.venueId : [query.venueId]).flatMap((value) => String(value).split(","));
    venueIds = [...new Set(raw.map((value) => parseId(value.trim())))];
    if (!raw.length || venueIds.includes(null)) fields.venueId = "Choose valid venue IDs.";
    else if (venueIds.length > MAX_VENUES) fields.venueId = `Choose at most ${MAX_VENUES} venues.`;
  }

  let check = null;
  if (query.checkStart !== undefined || query.checkEnd !== undefined) {
    const start = parseDate(Array.isArray(query.checkStart) ? null : query.checkStart);
    const end = parseDate(Array.isArray(query.checkEnd) ? null : query.checkEnd);
    if (!start || !end) fields.check = `Provide both checkStart and checkEnd. ${DATE_MESSAGE}`;
    else if (end <= start || end - start > MAX_RANGE_DAYS * DAY_MS) fields.check = "The requested period must end after it starts.";
    else check = { start, end };
  }

  if (Object.keys(fields).length) return { fields };
  return { query: { from, to, venueIds, check } };
};

// GET /api/venues/options/:venueId/availability?start=&end= (SPM-76): the
// organiser's requested time at one venue, named by the path.
const validateRequestAvailabilityQuery = (query) => {
  const fields = {};
  for (const key of Object.keys(query)) {
    if (key !== "start" && key !== "end") fields[key] = "This parameter is not supported.";
  }
  const start = parseDate(Array.isArray(query.start) ? null : query.start);
  const end = parseDate(Array.isArray(query.end) ? null : query.end);
  if (!start) fields.start = DATE_MESSAGE;
  if (!end) fields.end = DATE_MESSAGE;
  if (start && end && (end <= start || end - start > MAX_RANGE_DAYS * DAY_MS)) {
    fields.end = `The requested time must end after it starts and span at most ${MAX_RANGE_DAYS} days.`;
  }
  if (Object.keys(fields).length) return { fields };
  return { query: { start, end } };
};

module.exports = { validateAvailabilityQuery, validateRequestAvailabilityQuery, MAX_RANGE_DAYS, MAX_VENUES };
