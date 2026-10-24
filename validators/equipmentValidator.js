// Pure validation for the equipment catalogue (SPM-52); no database access.
// Each validate* function returns { values, fields }: values are trimmed and
// keyed as the database functions expect, fields maps API field names to
// messages. Every value accepted here must also be storable, so bad input
// becomes a 400, never a 500.
const {
  EQUIPMENT_STATUS,
  UNAVAILABILITY_REASONS,
  MAX_EQUIPMENT_QUANTITY,
} = require("../config/equipmentConstants");
const { toWholeNumber, MAX_INTEGER } = require("./eventValidator");

const LIMITS = Object.freeze({
  name: 100,
  category: 100,
  storageLocation: 150,
  detail: 2000,
  note: 500,
  search: 100,
});
const STATUSES = Object.values(EQUIPMENT_STATUS);
// An instant with an explicit offset, so the stored time never depends on the server's zone.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

// Wording of the SPM-52 test cases where they give one.
const MESSAGES = Object.freeze({
  bodyInvalid: "Send the equipment details as a JSON object.",
  unknownField: "This field cannot be set.",
  textInvalid: "Please enter text.",
  nameRequired: "Name is required",
  nameTooLong: `Name must be ${LIMITS.name} characters or fewer`,
  nameTaken: "Equipment with this name already exists",
  categoryRequired: "Category is required",
  categoryTooLong: `Category must be ${LIMITS.category} characters or fewer`,
  storageLocationRequired: "Storage location is required",
  storageLocationTooLong: `Storage location must be ${LIMITS.storageLocation} characters or fewer`,
  totalQuantityRequired: "Total quantity is required",
  totalQuantityInvalid: "Total quantity must be a whole number of 0 or more",
  totalQuantityTooLarge: `Total quantity must be ${MAX_EQUIPMENT_QUANTITY.toLocaleString("en-US")} or fewer`,
  detailTooLong: `Must be ${LIMITS.detail} characters or fewer`,
  activeInvalid: "Active must be true or false.",
  confirmInvalid: "Confirmation must be true or false.",
  versionRequired: "Send the version you loaded.",
  nothingToUpdate: "Change at least one equipment detail.",
  searchTooLong: `Search must be ${LIMITS.search} characters or fewer`,
  categoryFilterTooLong: `Category must be ${LIMITS.category} characters or fewer`,
  statusInvalid: "Status must be Active, Inactive or Details pending",
  quantityRequired: "Quantity is required",
  quantityInvalid: "Quantity must be a whole number greater than 0",
  reasonRequired: "Reason is required",
  reasonInvalid: "Reason must be Damaged, Maintenance or Other",
  startRequired: "Start is required",
  endRequired: "End is required",
  instantInvalid: "Enter a date and time with a time zone, for example 2026-11-02T09:00:00+08:00",
  endBeforeStart: "End must be after the start",
  endInPast: "End must be in the future",
  noteRequired: "Note is required",
  noteTooLong: `Note must be ${LIMITS.note} characters or fewer`,
});

// API field name -> key the database functions read.
const EQUIPMENT_KEYS = Object.freeze({
  name: "name",
  category: "category",
  storageLocation: "storage_location",
  totalQuantity: "total_quantity",
  specifications: "specifications",
  technicalNotes: "technicalNotes",
  handlingNotes: "handlingNotes",
});
const DETAIL_FIELDS = Object.freeze(["specifications", "technicalNotes", "handlingNotes"]);
const CREATE_FIELDS = new Set(Object.keys(EQUIPMENT_KEYS));
const UPDATE_FIELDS = new Set([...Object.keys(EQUIPMENT_KEYS), "version"]);
const STATUS_FIELDS = new Set(["active", "version", "confirmUpcomingRequests"]);

const UNAVAILABILITY_KEYS = Object.freeze({
  quantity: "quantity",
  reason: "reason",
  startsAt: "starts_at",
  endsAt: "ends_at",
  note: "note",
});
const UNAVAILABILITY_CREATE_FIELDS = new Set(Object.keys(UNAVAILABILITY_KEYS));
const UNAVAILABILITY_UPDATE_FIELDS = new Set([...Object.keys(UNAVAILABILITY_KEYS), "version"]);
const VERSION_ONLY_FIELDS = new Set(["version"]);

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isBlank = (value) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");
const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key);

// Returns the trimmed text, null when blank, or undefined for a non-string.
const readText = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? null : text;
};

const rejectUnknown = (body, allowed, fields) => {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) fields[key] = MESSAGES.unknownField;
  }
};

const checkText = (body, key, { required, tooLong, limit }, fields) => {
  const text = readText(body[key]);
  if (text === undefined) fields[key] = MESSAGES.textInvalid;
  else if (text === null && required) fields[key] = required;
  else if (text !== null && text.length > limit) fields[key] = tooLong;
  return text ?? null;
};

const checkTotalQuantity = (body, fields) => {
  if (isBlank(body.totalQuantity)) {
    fields.totalQuantity = MESSAGES.totalQuantityRequired;
    return null;
  }
  const quantity = toWholeNumber(body.totalQuantity);
  if (!Number.isInteger(quantity) || quantity < 0) {
    fields.totalQuantity = MESSAGES.totalQuantityInvalid;
    return null;
  }
  if (quantity > MAX_EQUIPMENT_QUANTITY) {
    fields.totalQuantity = MESSAGES.totalQuantityTooLarge;
    return null;
  }
  return quantity;
};

const EQUIPMENT_CHECKS = Object.freeze({
  name: (body, fields) => checkText(body, "name", { required: MESSAGES.nameRequired, tooLong: MESSAGES.nameTooLong, limit: LIMITS.name }, fields),
  category: (body, fields) => checkText(body, "category", { required: MESSAGES.categoryRequired, tooLong: MESSAGES.categoryTooLong, limit: LIMITS.category }, fields),
  storageLocation: (body, fields) => checkText(body, "storageLocation", {
    required: MESSAGES.storageLocationRequired,
    tooLong: MESSAGES.storageLocationTooLong,
    limit: LIMITS.storageLocation,
  }, fields),
  totalQuantity: checkTotalQuantity,
  ...Object.fromEntries(DETAIL_FIELDS.map((key) => [
    key,
    (body, fields) => checkText(body, key, { tooLong: MESSAGES.detailTooLong, limit: LIMITS.detail }, fields),
  ])),
});

const checkVersion = (version, fields) => {
  const number = toWholeNumber(version);
  if (!Number.isInteger(number) || number < 1 || number > MAX_INTEGER) fields.version = MESSAGES.versionRequired;
  return number;
};

// Create: name, category, storage location and total quantity are required;
// the detail fields are optional (SPM-52 AC2).
const validateEquipmentCreate = (body) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid } };
  const fields = {};
  rejectUnknown(body, CREATE_FIELDS, fields);
  const values = {};
  for (const [key, check] of Object.entries(EQUIPMENT_CHECKS)) {
    values[EQUIPMENT_KEYS[key]] = check(body, fields);
  }
  return { values, fields };
};

// Update: only the fields sent are checked and changed. A required field that
// is sent must not be blank; detail fields may be cleared.
const validateEquipmentUpdate = (body) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid }, version: null };
  const fields = {};
  rejectUnknown(body, UPDATE_FIELDS, fields);
  const version = checkVersion(body.version, fields);
  const values = {};
  for (const [key, check] of Object.entries(EQUIPMENT_CHECKS)) {
    if (has(body, key)) values[EQUIPMENT_KEYS[key]] = check(body, fields);
  }
  if (!Object.keys(values).length && !Object.keys(fields).length) fields.body = MESSAGES.nothingToUpdate;
  return { values, fields, version };
};

const checkBoolean = (body, key, message, fields, fallback) => {
  const value = body[key] ?? fallback;
  if (typeof value !== "boolean") fields[key] = message;
  return value === true;
};

const validateEquipmentStatusChange = (body) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid } };
  const fields = {};
  rejectUnknown(body, STATUS_FIELDS, fields);
  const active = checkBoolean(body, "active", MESSAGES.activeInvalid, fields, undefined);
  const version = checkVersion(body.version, fields);
  const confirmUpcomingRequests = checkBoolean(body, "confirmUpcomingRequests", MESSAGES.confirmInvalid, fields, false);
  return { values: { active, version, confirmUpcomingRequests }, fields };
};

// ---------- unavailable stock (SPM-52 AC8) ----------

const checkQuantity = (body, fields) => {
  if (isBlank(body.quantity)) {
    fields.quantity = MESSAGES.quantityRequired;
    return null;
  }
  const quantity = toWholeNumber(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_EQUIPMENT_QUANTITY) {
    fields.quantity = MESSAGES.quantityInvalid;
    return null;
  }
  return quantity;
};

const checkReason = (body, fields) => {
  if (isBlank(body.reason)) fields.reason = MESSAGES.reasonRequired;
  else if (!UNAVAILABILITY_REASONS.includes(body.reason)) fields.reason = MESSAGES.reasonInvalid;
  return typeof body.reason === "string" ? body.reason : null;
};

// Returns the instant as an ISO string, or null (with a message) when missing or invalid.
const checkInstant = (body, key, required, fields) => {
  if (isBlank(body[key])) {
    fields[key] = required;
    return null;
  }
  const time = typeof body[key] === "string" && INSTANT.test(body[key].trim()) ? Date.parse(body[key].trim()) : NaN;
  if (Number.isNaN(time)) {
    fields[key] = MESSAGES.instantInvalid;
    return null;
  }
  return new Date(time).toISOString();
};

const UNAVAILABILITY_CHECKS = Object.freeze({
  quantity: checkQuantity,
  reason: checkReason,
  startsAt: (body, fields) => checkInstant(body, "startsAt", MESSAGES.startRequired, fields),
  endsAt: (body, fields) => checkInstant(body, "endsAt", MESSAGES.endRequired, fields),
  note: (body, fields) => checkText(body, "note", { required: MESSAGES.noteRequired, tooLong: MESSAGES.noteTooLong, limit: LIMITS.note }, fields),
});

// The period must run forwards and end in the future. The database repeats
// both checks; this gives the field messages.
const checkPeriod = (startsAt, endsAt, now, fields) => {
  if (!startsAt || !endsAt || fields.startsAt || fields.endsAt) return;
  if (Date.parse(endsAt) <= Date.parse(startsAt)) fields.endsAt = MESSAGES.endBeforeStart;
  else if (Date.parse(endsAt) <= now.getTime()) fields.endsAt = MESSAGES.endInPast;
};

const validateUnavailabilityCreate = (body, now = new Date()) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid } };
  const fields = {};
  rejectUnknown(body, UNAVAILABILITY_CREATE_FIELDS, fields);
  const values = {};
  for (const [key, check] of Object.entries(UNAVAILABILITY_CHECKS)) {
    values[UNAVAILABILITY_KEYS[key]] = check(body, fields);
  }
  checkPeriod(values.starts_at, values.ends_at, now, fields);
  return { values, fields };
};

// current is the stored record (column names), used to check the period when
// only one end of it changes.
const validateUnavailabilityUpdate = (body, current, now = new Date()) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid }, version: null };
  const fields = {};
  rejectUnknown(body, UNAVAILABILITY_UPDATE_FIELDS, fields);
  const version = checkVersion(body.version, fields);
  const values = {};
  for (const [key, check] of Object.entries(UNAVAILABILITY_CHECKS)) {
    if (has(body, key)) values[UNAVAILABILITY_KEYS[key]] = check(body, fields);
  }
  if (!Object.keys(values).length && !Object.keys(fields).length) fields.body = MESSAGES.nothingToUpdate;
  const toIso = (value) => (value ? new Date(value).toISOString() : null);
  checkPeriod(values.starts_at ?? toIso(current?.starts_at), values.ends_at ?? toIso(current?.ends_at), now, fields);
  return { values, fields, version };
};

const validateVersionOnly = (body) => {
  if (!isPlainObject(body)) return { version: null, fields: { body: MESSAGES.bodyInvalid } };
  const fields = {};
  rejectUnknown(body, VERSION_ONLY_FIELDS, fields);
  return { version: checkVersion(body.version, fields), fields };
};

// GET /api/equipment filters (SPM-52 AC5).
const validateEquipmentListQuery = (query) => {
  const fields = {};
  const filters = {};
  const search = readText(query.search);
  const category = readText(query.category);
  if (search === undefined) fields.search = MESSAGES.textInvalid;
  else if (search && search.length > LIMITS.search) fields.search = MESSAGES.searchTooLong;
  else if (search) filters.search = search;
  if (category === undefined) fields.category = MESSAGES.textInvalid;
  else if (category && category.length > LIMITS.category) fields.category = MESSAGES.categoryFilterTooLong;
  else if (category) filters.category = category;
  if (query.status !== undefined && query.status !== "") {
    if (STATUSES.includes(query.status)) filters.status = query.status;
    else fields.status = MESSAGES.statusInvalid;
  }
  return { filters, fields };
};

// IDs that cannot exist are "not found".
const parseId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= MAX_INTEGER ? Number(value) : null;

const hasErrors = (fields) => Object.keys(fields).length > 0;

module.exports = {
  validateEquipmentCreate,
  validateEquipmentUpdate,
  validateEquipmentStatusChange,
  validateUnavailabilityCreate,
  validateUnavailabilityUpdate,
  validateVersionOnly,
  validateEquipmentListQuery,
  parseId,
  hasErrors,
  MESSAGES,
  LIMITS,
  DETAIL_FIELDS,
};
