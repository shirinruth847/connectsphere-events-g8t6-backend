// Pure validation for venue maintenance (SPM-73); no database access.
// Each validate* function returns { values, fields }: values are trimmed and
// keyed by column name, fields maps API field names to messages. Every value
// accepted here must also be storable, so bad input becomes a 400, never a 500.
const { VENUE_STATUS, MAX_VENUE_CAPACITY } = require("../config/venueConstants");
const { toWholeNumber, parseDate, MAX_INTEGER } = require("./eventValidator");

const LIMITS = Object.freeze({
  name: 150,
  address: 255,
  contactPerson: 100,
  contactEmail: 150,
  contactNumber: 30,
  statusReason: 500,
  search: 150,
});
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONTACT_NUMBER = /^\+?[0-9(][0-9 ()-]*$/;
const CONTACT_NUMBER_DIGITS = { min: 7, max: 15 }; // E.164 allows at most 15 digits
const STATUSES = Object.values(VENUE_STATUS);

// Wording of the SPM-73 test cases where they give one.
const MESSAGES = Object.freeze({
  bodyInvalid: "Send the venue details as a JSON object.",
  unknownField: "This field cannot be set.",
  textInvalid: "Please enter text.",
  nameRequired: "Venue name is required",
  nameTooLong: `Venue name must be ${LIMITS.name} characters or fewer`,
  nameTaken: "A venue with this name already exists",
  addressRequired: "Address is required",
  addressTooLong: `Address must be ${LIMITS.address} characters or fewer`,
  capacityRequired: "Capacity is required",
  capacityInvalid: "Capacity must be a positive whole number",
  capacityTooLarge: `Capacity must be ${MAX_VENUE_CAPACITY.toLocaleString("en-US")} or fewer`,
  contactPersonRequired: "Contact person is required",
  contactPersonTooLong: `Contact person must be ${LIMITS.contactPerson} characters or fewer`,
  contactRequired: "Enter a contact number or email",
  emailInvalid: "Enter a valid email address, for example name@example.com",
  numberInvalid: "Enter a valid contact number, for example +65 6123 4567",
  statusRequired: "Venue status is required",
  statusInvalid: "Status must be Active, Inactive or Under Maintenance",
  statusNotEditable: "Change the status with the status action.",
  reasonRequired: "Enter a reason for putting the venue under maintenance",
  reasonTooLong: `Reason must be ${LIMITS.statusReason} characters or fewer`,
  confirmInvalid: "Confirmation must be true or false.",
  versionRequired: "Send the version of the venue you loaded.",
  nothingToUpdate: "Change at least one venue detail.",
  searchTooLong: `Search must be ${LIMITS.search} characters or fewer`,
  locationTooLong: `Location must be ${LIMITS.address} characters or fewer`,
});

// API field name → column name for the details Venue Staff may edit.
const DETAIL_COLUMNS = Object.freeze({
  name: "name",
  address: "address",
  maxCapacity: "max_capacity",
  contactPerson: "contact_person",
  contactEmail: "contact_email",
  contactNumber: "contact_number",
});
const CREATE_FIELDS = new Set([...Object.keys(DETAIL_COLUMNS), "status", "statusReason"]);
const UPDATE_FIELDS = new Set([...Object.keys(DETAIL_COLUMNS), "version"]);
const STATUS_FIELDS = new Set(["status", "reason", "version", "confirmUpcomingBookings"]);

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

// Returns the trimmed text, null when blank, or undefined for a non-string.
const readText = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? null : text;
};

const rejectUnknown = (body, allowed, fields) => {
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    fields[key] = key === "status" ? MESSAGES.statusNotEditable : MESSAGES.unknownField;
  }
};

// Validates one text field; returns the stored value (string or null).
const checkText = (body, key, { required, tooLong, limit }, fields) => {
  const text = readText(body[key]);
  if (text === undefined) {
    fields[key] = MESSAGES.textInvalid;
  } else if (text === null) {
    if (required) fields[key] = required;
  } else if (text.length > limit) {
    fields[key] = tooLong;
  }
  return text ?? null;
};

const checkCapacity = (body, fields) => {
  if (isBlank(body.maxCapacity)) {
    fields.maxCapacity = MESSAGES.capacityRequired;
    return null;
  }
  const capacity = toWholeNumber(body.maxCapacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_INTEGER) {
    fields.maxCapacity = MESSAGES.capacityInvalid;
    return null;
  }
  if (capacity > MAX_VENUE_CAPACITY) {
    fields.maxCapacity = MESSAGES.capacityTooLarge;
    return null;
  }
  return capacity;
};

const checkEmail = (body, fields) => {
  const email = readText(body.contactEmail);
  if (email === undefined) fields.contactEmail = MESSAGES.textInvalid;
  else if (email !== null && (email.length > LIMITS.contactEmail || !EMAIL.test(email))) fields.contactEmail = MESSAGES.emailInvalid;
  return typeof email === "string" ? email.toLowerCase() : null;
};

const checkContactNumber = (body, fields) => {
  const number = readText(body.contactNumber);
  if (number === undefined) {
    fields.contactNumber = MESSAGES.textInvalid;
  } else if (number !== null) {
    const digits = number.replace(/\D/g, "").length;
    if (
      number.length > LIMITS.contactNumber
      || !CONTACT_NUMBER.test(number)
      || digits < CONTACT_NUMBER_DIGITS.min
      || digits > CONTACT_NUMBER_DIGITS.max
    ) {
      fields.contactNumber = MESSAGES.numberInvalid;
    }
  }
  return number ?? null;
};

const DETAIL_CHECKS = Object.freeze({
  name: (body, fields) => checkText(body, "name", { required: MESSAGES.nameRequired, tooLong: MESSAGES.nameTooLong, limit: LIMITS.name }, fields),
  address: (body, fields) => checkText(body, "address", { required: MESSAGES.addressRequired, tooLong: MESSAGES.addressTooLong, limit: LIMITS.address }, fields),
  maxCapacity: checkCapacity,
  contactPerson: (body, fields) => checkText(body, "contactPerson", { required: MESSAGES.contactPersonRequired, tooLong: MESSAGES.contactPersonTooLong, limit: LIMITS.contactPerson }, fields),
  contactEmail: checkEmail,
  contactNumber: checkContactNumber,
});

const checkStatus = (status, fields) => {
  if (isBlank(status)) {
    fields.status = MESSAGES.statusRequired;
  } else if (!STATUSES.includes(status)) {
    fields.status = MESSAGES.statusInvalid;
  }
};

const checkReason = (body, key, status, fields) => {
  const reason = readText(body[key]);
  if (reason === undefined) fields[key] = MESSAGES.textInvalid;
  else if (reason !== null && reason.length > LIMITS.statusReason) fields[key] = MESSAGES.reasonTooLong;
  else if (reason === null && status === VENUE_STATUS.UNDER_MAINTENANCE) fields[key] = MESSAGES.reasonRequired;
  return status === VENUE_STATUS.ACTIVE ? null : reason ?? null;
};

const checkVersion = (version, fields) => {
  const number = toWholeNumber(version);
  if (!Number.isInteger(number) || number < 1 || number > MAX_INTEGER) fields.version = MESSAGES.versionRequired;
  return number;
};

// Create: every detail is mandatory, plus a contact number or email (SPM-73 AC3).
// The status defaults to ACTIVE, the status a created venue is saved with.
const validateVenueCreate = (body) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid } };
  const fields = {};
  rejectUnknown(body, CREATE_FIELDS, fields);

  const values = {};
  for (const [key, check] of Object.entries(DETAIL_CHECKS)) {
    values[DETAIL_COLUMNS[key]] = check(body, fields);
  }
  if (values.contact_email === null && values.contact_number === null && !fields.contactEmail && !fields.contactNumber) {
    fields.contactNumber = MESSAGES.contactRequired;
  }

  values.status = body.status === undefined ? VENUE_STATUS.ACTIVE : body.status;
  checkStatus(values.status, fields);
  values.status_reason = checkReason(body, "statusReason", values.status, fields);
  return { values, fields };
};

// Update: only the details sent are checked and changed. current is the loaded
// venue (column names), used to keep at least one contact method once either
// contact field is edited. Status changes go through validateVenueStatusChange.
const validateVenueUpdate = (body, current) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid }, version: null };
  const fields = {};
  rejectUnknown(body, UPDATE_FIELDS, fields);
  const version = checkVersion(body.version, fields);

  const values = {};
  for (const [key, check] of Object.entries(DETAIL_CHECKS)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) values[DETAIL_COLUMNS[key]] = check(body, fields);
  }
  if (!Object.keys(values).length && !Object.keys(fields).length) fields.body = MESSAGES.nothingToUpdate;

  const touchesContact = "contact_email" in values || "contact_number" in values;
  const email = "contact_email" in values ? values.contact_email : current?.contact_email ?? null;
  const number = "contact_number" in values ? values.contact_number : current?.contact_number ?? null;
  if (touchesContact && email === null && number === null && !fields.contactEmail && !fields.contactNumber) {
    fields.contactNumber = MESSAGES.contactRequired;
  }
  return { values, fields, version };
};

const validateVenueStatusChange = (body) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid } };
  const fields = {};
  rejectUnknown(body, STATUS_FIELDS, fields);
  checkStatus(body.status, fields);
  const version = checkVersion(body.version, fields);
  const reason = checkReason(body, "reason", body.status, fields);
  const confirm = body.confirmUpcomingBookings ?? false;
  if (typeof confirm !== "boolean") fields.confirmUpcomingBookings = MESSAGES.confirmInvalid;
  return { values: { status: body.status, reason, version, confirmUpcomingBookings: confirm === true }, fields };
};

const MANAGED_VENUE_SORTS = Object.freeze(["name", "capacity", "updatedAt", "setupMinutes", "turnaroundMinutes"]);

// GET /api/venues/manage filters (SPM-73 search and filter, SPM-181 sort).
const validateVenueListQuery = (query) => {
  const fields = {};
  const filters = { sort: "name", order: "asc" };
  const search = readText(query.search);
  const location = readText(query.location);
  if (search === undefined) fields.search = MESSAGES.textInvalid;
  else if (search && search.length > LIMITS.search) fields.search = MESSAGES.searchTooLong;
  else if (search) filters.search = search;
  if (location === undefined) fields.location = MESSAGES.textInvalid;
  else if (location && location.length > LIMITS.address) fields.location = MESSAGES.locationTooLong;
  else if (location) filters.location = location;
  if (query.status !== undefined && query.status !== "") {
    if (STATUSES.includes(query.status)) filters.status = query.status;
    else fields.status = MESSAGES.statusInvalid;
  }
  if (query.sort !== undefined) {
    if (MANAGED_VENUE_SORTS.includes(query.sort)) filters.sort = query.sort;
    else fields.sort = `Sort must be one of ${MANAGED_VENUE_SORTS.join(", ")}.`;
  }
  if (query.order !== undefined) {
    if (query.order === "asc" || query.order === "desc") filters.order = query.order;
    else fields.order = "Order must be asc or desc.";
  }
  return { filters, fields };
};

// ---------- MongoDB venue details (Master 6.4, T27) ----------

const DETAIL_LIMITS = Object.freeze({
  description: 2000,
  emergencyAccess: 1000,
  maxBufferMinutes: 1440,
  lists: {
    facilities: { items: 50, length: 100 },
    accessibilityFeatures: { items: 50, length: 100 },
    supportedLayouts: { items: 20, length: 100 },
    knownRestrictions: { items: 50, length: 200 },
  },
});
const DETAIL_MESSAGES = Object.freeze({
  versionRequired: "Send the details version you loaded (0 when the venue has no details yet).",
  descriptionTooLong: `Description must be ${DETAIL_LIMITS.description} characters or fewer`,
  emergencyAccessTooLong: `Emergency access must be ${DETAIL_LIMITS.emergencyAccess} characters or fewer`,
  minutesInvalid: `Enter whole minutes from 0 to ${DETAIL_LIMITS.maxBufferMinutes}`,
  listInvalid: (items, length) => `Enter up to ${items} entries of ${length} characters or fewer`,
  nothingToUpdate: "Change at least one venue detail.",
});
const DETAIL_FIELDS = new Set([
  "version",
  "description",
  "emergencyAccess",
  "setupMinutes",
  "turnaroundMinutes",
  ...Object.keys(DETAIL_LIMITS.lists),
]);

// Trimmed, non-empty, de-duplicated entries (case-insensitive), or undefined when invalid.
const readList = (value, { items, length }) => {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set();
  const list = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const text = item.trim();
    if (!text) continue;
    if (text.length > length) return undefined;
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    list.push(text);
  }
  return list.length <= items ? list : undefined;
};

// PUT /api/venues/:venueId/details: only the fields sent are changed.
const validateVenueDetails = (body) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid }, version: null };
  const fields = {};
  rejectUnknown(body, DETAIL_FIELDS, fields);
  const version = toWholeNumber(body.version);
  if (!Number.isInteger(version) || version < 0 || version > MAX_INTEGER) fields.version = DETAIL_MESSAGES.versionRequired;

  const values = {};
  for (const [key, limit, message] of [
    ["description", DETAIL_LIMITS.description, DETAIL_MESSAGES.descriptionTooLong],
    ["emergencyAccess", DETAIL_LIMITS.emergencyAccess, DETAIL_MESSAGES.emergencyAccessTooLong],
  ]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const text = readText(body[key]);
    if (text === undefined) fields[key] = MESSAGES.textInvalid;
    else if (text !== null && text.length > limit) fields[key] = message;
    else values[key] = text;
  }
  for (const [key, limit] of Object.entries(DETAIL_LIMITS.lists)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const list = readList(body[key], limit);
    if (list === undefined) fields[key] = DETAIL_MESSAGES.listInvalid(limit.items, limit.length);
    else values[key] = list;
  }
  for (const key of ["setupMinutes", "turnaroundMinutes"]) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const minutes = toWholeNumber(body[key]);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > DETAIL_LIMITS.maxBufferMinutes) fields[key] = DETAIL_MESSAGES.minutesInvalid;
    else values[key] = minutes;
  }
  if (!Object.keys(values).length && !Object.keys(fields).length) fields.body = DETAIL_MESSAGES.nothingToUpdate;
  return { values, fields, version };
};

// ---------- catalogue search and filters (GET /api/venues) ----------

const CATALOGUE_PARAMS = new Set(["search", "minCapacity", "layout", "facility", "accessibility"]);
// layout, facility and accessibility take several values as repeated
// parameters (developer request of 25 October 2026), matched as "any of";
// one value still works.
const LIST_FILTERS = ["layout", "facility", "accessibility"];
const MAX_FILTER_VALUES = 10;

const validateCatalogueQuery = (query) => {
  const fields = {};
  const filters = {};
  for (const key of Object.keys(query)) {
    if (!CATALOGUE_PARAMS.has(key)) fields[key] = "This filter is not supported.";
  }
  if (query.search !== undefined) {
    const text = readText(query.search);
    if (text === undefined) fields.search = MESSAGES.textInvalid;
    else if (text && text.length > LIMITS.search) fields.search = MESSAGES.searchTooLong;
    else if (text) filters.search = text;
  }
  for (const key of LIST_FILTERS) {
    if (query[key] === undefined) continue;
    const texts = (Array.isArray(query[key]) ? query[key] : [query[key]]).map(readText);
    if (texts.some((text) => text === undefined)) fields[key] = MESSAGES.textInvalid;
    else if (texts.some((text) => text && text.length > LIMITS.search)) fields[key] = MESSAGES.searchTooLong;
    else {
      // The first spelling of each value is kept.
      const values = texts.filter(Boolean).filter((text, index, all) => all.findIndex((other) => other.toLowerCase() === text.toLowerCase()) === index);
      if (values.length > MAX_FILTER_VALUES) fields[key] = `Choose at most ${MAX_FILTER_VALUES} values.`;
      else if (values.length) filters[key] = values;
    }
  }
  if (query.minCapacity !== undefined && query.minCapacity !== "") {
    const capacity = toWholeNumber(query.minCapacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_VENUE_CAPACITY) fields.minCapacity = MESSAGES.capacityInvalid;
    else filters.minCapacity = capacity;
  }
  return { filters, fields };
};

// ---------- event venue options (GET /api/events/:id/venue-options, SPM-72/74) ----------

const VENUE_OPTION_SORTS = Object.freeze(["match", "name", "capacity", "setup", "turnaround"]);
const MAX_REQUIRED_FACILITIES = 10;
const FACILITY_TERM_LIMIT = 100;

// The catalogue filters plus the coordinator's required facilities (ranked and
// highlighted, never filtered out), sort and order.
const validateVenueOptionsQuery = (query) => {
  const { requiredFacilities, sort, order, ...catalogueQuery } = query;
  const { filters, fields } = validateCatalogueQuery(catalogueQuery);
  const options = { filters, requiredFacilities: [], sort: "match", order: "asc" };

  if (requiredFacilities !== undefined) {
    const terms = typeof requiredFacilities === "string"
      ? requiredFacilities.split(",").map((term) => term.trim()).filter(Boolean)
      : null;
    if (!terms) fields.requiredFacilities = MESSAGES.textInvalid;
    else if (terms.length > MAX_REQUIRED_FACILITIES) fields.requiredFacilities = `Enter at most ${MAX_REQUIRED_FACILITIES} facilities.`;
    else if (terms.some((term) => term.length > FACILITY_TERM_LIMIT)) fields.requiredFacilities = `Each facility must be ${FACILITY_TERM_LIMIT} characters or fewer.`;
    else options.requiredFacilities = [...new Set(terms)];
  }
  if (sort !== undefined) {
    if (!VENUE_OPTION_SORTS.includes(sort)) fields.sort = `Sort by one of: ${VENUE_OPTION_SORTS.join(", ")}.`;
    else options.sort = sort;
  }
  if (order !== undefined) {
    if (order !== "asc" && order !== "desc") fields.order = "Order must be asc or desc.";
    else options.order = order;
  }
  return { options, fields };
};

// ---------- organiser venue options (GET /api/venues/options, SPM-76) ----------

const REQUEST_NEED_PARAMS = new Set(["startDatetime", "endDatetime", "expectedAttendance", "preferredLayoutType", "accessibilityNeeds"]);
// The same bound as the availability calendar's range.
const MAX_REQUEST_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_REQUEST_NEEDS = 20;
const REQUEST_NEED_LIMIT = 200;
const REQUEST_DATE_MESSAGE = "Enter a valid date and time.";

// The organiser's unsaved form values arrive with the filters; each is
// optional while the form is incomplete. `need` is in event-row shape.
const validateRequestVenueOptionsQuery = (query) => {
  const needQuery = {};
  const optionQuery = {};
  for (const [key, value] of Object.entries(query)) {
    if (REQUEST_NEED_PARAMS.has(key)) needQuery[key] = value;
    else optionQuery[key] = value;
  }
  const { options, fields } = validateVenueOptionsQuery(optionQuery);
  const need = { start_datetime: null, end_datetime: null, expected_attendance: null, preferred_layout_type: null, accessibility_needs: [] };

  const readDate = (key) => {
    const text = readText(needQuery[key]);
    if (text === null) return null;
    const date = text === undefined ? null : parseDate(text);
    if (!date) fields[key] = REQUEST_DATE_MESSAGE;
    return date;
  };
  const start = readDate("startDatetime");
  const end = readDate("endDatetime");
  if (start && end) {
    if (end <= start) fields.endDatetime = "End time must be after start time.";
    else if (end - start > MAX_REQUEST_WINDOW_MS) fields.endDatetime = "The event can last at most 366 days.";
    else {
      need.start_datetime = start.toISOString();
      need.end_datetime = end.toISOString();
    }
  }

  const attendance = readText(needQuery.expectedAttendance);
  if (attendance !== null) {
    const number = attendance === undefined ? NaN : toWholeNumber(attendance);
    if (!Number.isInteger(number) || number < 1 || number > MAX_INTEGER) fields.expectedAttendance = "Expected attendance must be a whole number of at least 1.";
    else need.expected_attendance = number;
  }

  const layout = readText(needQuery.preferredLayoutType);
  if (layout === undefined || (layout && layout.length > LIMITS.search)) fields.preferredLayoutType = MESSAGES.textInvalid;
  else need.preferred_layout_type = layout;

  if (needQuery.accessibilityNeeds !== undefined) {
    const needs = (Array.isArray(needQuery.accessibilityNeeds) ? needQuery.accessibilityNeeds : [needQuery.accessibilityNeeds]).map(readText);
    if (needs.length > MAX_REQUEST_NEEDS || needs.some((item) => item === undefined || (item && item.length > REQUEST_NEED_LIMIT))) {
      fields.accessibilityNeeds = `Send at most ${MAX_REQUEST_NEEDS} accessibility needs of ${REQUEST_NEED_LIMIT} characters or fewer.`;
    } else {
      need.accessibility_needs = needs.filter(Boolean);
    }
  }
  return { need, options, fields };
};

const hasErrors = (fields) => Object.keys(fields).length > 0;

module.exports = {
  validateVenueCreate,
  validateVenueUpdate,
  validateVenueStatusChange,
  validateVenueListQuery,
  MANAGED_VENUE_SORTS,
  validateVenueDetails,
  validateCatalogueQuery,
  validateVenueOptionsQuery,
  validateRequestVenueOptionsQuery,
  VENUE_OPTION_SORTS,
  hasErrors,
  MESSAGES,
  DETAIL_MESSAGES,
  LIMITS,
};
