// Pure validation for the equipment catalogue (SPM-52); no database access.
// Each validate* function returns { values, fields }: values are trimmed and
// keyed as the database functions expect, fields maps API field names to
// messages. Every value accepted here must also be storable, so bad input
// becomes a 400, never a 500.
const {
  EQUIPMENT_STATUS,
  UNAVAILABILITY_REASONS,
  MAX_EQUIPMENT_QUANTITY,
  TECHNICAL_REQUEST_STATUS,
  TECHNICAL_DECISIONS,
  MAX_TECHNICAL_REQUEST_ITEMS,
  MAX_TECHNICAL_ITEM_QUANTITY,
  MAX_REJECTION_REASON,
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
  // Technical requests (SPM-286/287).
  itemsRequired: `Choose between 1 and ${MAX_TECHNICAL_REQUEST_ITEMS} equipment items.`,
  itemInvalid: "Choose a catalogue item for each line, once.",
  itemQuantityInvalid: "Quantity must be a whole number of 1 or more.",
  unknownEquipment: "This equipment is not in the catalogue.",
  requestStatusInvalid: "Status must be Pending, Approved or Rejected",
  decisionInvalid: "Decision must be APPROVE or REJECT.",
  rejectionReasonRequired: "A reason is required to reject the request.",
  rejectionReasonTooLong: `Reason must be ${MAX_REJECTION_REASON} characters or fewer`,
  windowIncomplete: "Send both start and end, or neither.",
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

const hasErrors = (fields) => Object.keys(fields).length > 0;

// Runs each field's check and keys the result as the database function expects.
// An update checks only the fields that were sent.
const collectValues = (checks, keys, body, fields, { sentOnly = false } = {}) => {
  const values = {};
  for (const [key, check] of Object.entries(checks)) {
    if (!sentOnly || has(body, key)) values[keys[key]] = check(body, fields);
  }
  return values;
};

const requireSomeChange = (values, fields) => {
  if (!Object.keys(values).length && !hasErrors(fields)) fields.body = MESSAGES.nothingToUpdate;
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
  const values = collectValues(EQUIPMENT_CHECKS, EQUIPMENT_KEYS, body, fields);
  return { values, fields };
};

// Update: only the fields sent are checked and changed. A required field that
// is sent must not be blank; detail fields may be cleared.
const validateEquipmentUpdate = (body) => {
  if (!isPlainObject(body)) return { values: {}, fields: { body: MESSAGES.bodyInvalid }, version: null };
  const fields = {};
  rejectUnknown(body, UPDATE_FIELDS, fields);
  const version = checkVersion(body.version, fields);
  const values = collectValues(EQUIPMENT_CHECKS, EQUIPMENT_KEYS, body, fields, { sentOnly: true });
  requireSomeChange(values, fields);
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
  const values = collectValues(UNAVAILABILITY_CHECKS, UNAVAILABILITY_KEYS, body, fields);
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
  const values = collectValues(UNAVAILABILITY_CHECKS, UNAVAILABILITY_KEYS, body, fields, { sentOnly: true });
  requireSomeChange(values, fields);
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

// A blank filter is left out; text over the limit is refused.
const checkTextFilter = (query, key, { limit, tooLong }, filters, fields) => {
  const text = readText(query[key]);
  if (text === undefined) fields[key] = MESSAGES.textInvalid;
  else if (text && text.length > limit) fields[key] = tooLong;
  else if (text) filters[key] = text;
};

// GET /api/equipment filters (SPM-52 AC5).
const validateEquipmentListQuery = (query) => {
  const fields = {};
  const filters = {};
  checkTextFilter(query, "search", { limit: LIMITS.search, tooLong: MESSAGES.searchTooLong }, filters, fields);
  checkTextFilter(query, "category", { limit: LIMITS.category, tooLong: MESSAGES.categoryFilterTooLong }, filters, fields);
  if (query.status !== undefined && query.status !== "") {
    if (STATUSES.includes(query.status)) filters.status = query.status;
    else fields.status = MESSAGES.statusInvalid;
  }
  return { filters, fields };
};

// IDs that cannot exist are "not found".
const parseId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,9}$/.test(value) && Number(value) <= MAX_INTEGER ? Number(value) : null;

// ---------- technical requests (SPM-286/287) ----------

const REQUEST_STATUSES = Object.values(TECHNICAL_REQUEST_STATUS);

// GET /api/events/equipment-options?start&end. No window: usable stock only (SPM-286 AC2).
const validateAvailabilityWindow = (query) => {
  const fields = {};
  const hasStart = !isBlank(query.start);
  const hasEnd = !isBlank(query.end);
  if (!hasStart && !hasEnd) return { values: { start: null, end: null }, fields };
  if (hasStart !== hasEnd) return { values: {}, fields: { [hasStart ? "end" : "start"]: MESSAGES.windowIncomplete } };
  const start = checkInstant(query, "start", MESSAGES.startRequired, fields);
  const end = checkInstant(query, "end", MESSAGES.endRequired, fields);
  if (start && end && start >= end) fields.end = MESSAGES.endBeforeStart;
  return { values: { start, end }, fields };
};

const isItemQuantity = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_TECHNICAL_ITEM_QUANTITY;

// POST /api/events/:id/technical-requests: { items: [{ equipmentId, quantity }] }.
// Field keys name the line, e.g. "items[1].quantity" (SPM-286 AC7).
const validateTechnicalItems = (body) => {
  const items = body && typeof body === "object" && !Array.isArray(body) ? body.items : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_TECHNICAL_REQUEST_ITEMS) {
    return { values: {}, fields: { items: MESSAGES.itemsRequired } };
  }
  const fields = {};
  const seen = new Set();
  items.forEach((item, index) => {
    const valid = item && typeof item === "object" && !Array.isArray(item)
      && Object.keys(item).every((key) => key === "equipmentId" || key === "quantity");
    const equipmentId = valid ? toWholeNumber(item.equipmentId) : NaN;
    if (!Number.isInteger(equipmentId) || equipmentId < 1 || equipmentId > MAX_INTEGER || seen.has(equipmentId)) {
      fields[`items[${index}].equipmentId`] = MESSAGES.itemInvalid;
    } else {
      seen.add(equipmentId);
    }
    if (!valid || !isItemQuantity(item.quantity)) fields[`items[${index}].quantity`] = MESSAGES.itemQuantityInvalid;
  });
  return {
    values: { items: items.map((item) => ({ equipmentId: toWholeNumber(item?.equipmentId), quantity: item?.quantity })) },
    fields,
  };
};

// POST /api/equipment/requests/:requestId/decision: { decision, reason } (SPM-287 AC5).
const validateTechnicalDecision = (body) => {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const fields = {};
  if (!TECHNICAL_DECISIONS.includes(source.decision)) fields.decision = MESSAGES.decisionInvalid;
  const reason = readText(source.reason);
  if (reason === undefined) fields.reason = MESSAGES.textInvalid;
  else if (source.decision === "REJECT" && !reason) fields.reason = MESSAGES.rejectionReasonRequired;
  else if (reason && reason.length > MAX_REJECTION_REASON) fields.reason = MESSAGES.rejectionReasonTooLong;
  return { values: { decision: source.decision, reason: source.decision === "REJECT" ? reason : null }, fields };
};

// GET /api/equipment/requests filters (SPM-287 AC2).
const validateTechnicalRequestListQuery = (query) => {
  const fields = {};
  const filters = {};
  checkTextFilter(query, "search", { limit: LIMITS.search, tooLong: MESSAGES.searchTooLong }, filters, fields);
  if (query.status !== undefined && query.status !== "") {
    if (REQUEST_STATUSES.includes(query.status)) filters.status = query.status;
    else fields.status = MESSAGES.requestStatusInvalid;
  }
  return { filters, fields };
};

module.exports = {
  validateEquipmentCreate,
  validateEquipmentUpdate,
  validateEquipmentStatusChange,
  validateUnavailabilityCreate,
  validateUnavailabilityUpdate,
  validateVersionOnly,
  validateEquipmentListQuery,
  validateAvailabilityWindow,
  validateTechnicalItems,
  validateTechnicalDecision,
  validateTechnicalRequestListQuery,
  parseId,
  hasErrors,
  MESSAGES,
  LIMITS,
  DETAIL_FIELDS,
};
