// Pure validation for venue maintenance (SPM-73); no database access.
// Each validate* function returns { values, fields }: values are trimmed and
// keyed by column name, fields maps API field names to messages. Every value
// accepted here must also be storable, so bad input becomes a 400, never a 500.
const { VENUE_STATUS, MAX_VENUE_CAPACITY } = require("../config/venueConstants");
const { toWholeNumber, MAX_INTEGER } = require("./eventValidator");

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

// GET /api/venues/manage filters (SPM-73 search and filter).
const validateVenueListQuery = (query) => {
  const fields = {};
  const filters = {};
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

const validateCatalogueQuery = (query) => {
  const fields = {};
  const filters = {};
  for (const key of Object.keys(query)) {
    if (!CATALOGUE_PARAMS.has(key)) fields[key] = "This filter is not supported.";
  }
  for (const key of ["search", "layout", "facility", "accessibility"]) {
    if (query[key] === undefined) continue;
    const text = readText(query[key]);
    if (text === undefined) fields[key] = MESSAGES.textInvalid;
    else if (text && text.length > LIMITS.search) fields[key] = MESSAGES.searchTooLong;
    else if (text) filters[key] = text;
  }
  if (query.minCapacity !== undefined && query.minCapacity !== "") {
    const capacity = toWholeNumber(query.minCapacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_VENUE_CAPACITY) fields.minCapacity = MESSAGES.capacityInvalid;
    else filters.minCapacity = capacity;
  }
  return { filters, fields };
};

const hasErrors = (fields) => Object.keys(fields).length > 0;

module.exports = {
  validateVenueCreate,
  validateVenueUpdate,
  validateVenueStatusChange,
  validateVenueListQuery,
  validateVenueDetails,
  validateCatalogueQuery,
  hasErrors,
  MESSAGES,
  DETAIL_MESSAGES,
  LIMITS,
};
