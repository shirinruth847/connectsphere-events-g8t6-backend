const equipmentModel = require("../model/equipmentModel");
const {
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
} = require("../validators/equipmentValidator");
const { UNAVAILABILITY_STATUS } = require("../config/equipmentConstants");

const DOMAIN_ERRORS = Object.freeze({
  // Same response as requireRole: the database re-checks the role in the write.
  FORBIDDEN: [403, "You do not have permission to access this resource."],
  EQUIPMENT_NOT_FOUND: [404, "Equipment not found."],
  UNAVAILABILITY_NOT_FOUND: [404, "Unavailable stock record not found."],
  UNAVAILABILITY_VERSION_CONFLICT: [409, "This unavailable stock record was changed after you loaded it. Reload it, then try again."],
  UNAVAILABILITY_ENDED: [409, "This unavailable stock record has ended and can no longer be changed."],
});

const sendError = (res, status, code, error, extra) => res.status(status).json({ error, code, ...extra });

const validationFailed = (res, fields) =>
  sendError(res, 400, "VALIDATION_FAILED", "Please correct the highlighted fields.", { fields });

const equipmentNotFound = (res) => sendError(res, 404, "EQUIPMENT_NOT_FOUND", DOMAIN_ERRORS.EQUIPMENT_NOT_FOUND[1]);
const unavailabilityNotFound = (res) =>
  sendError(res, 404, "UNAVAILABILITY_NOT_FOUND", DOMAIN_ERRORS.UNAVAILABILITY_NOT_FOUND[1]);

// Periods are named in Singapore time, as the Equipment page enters and shows
// them: "Mon, 6 Jan 2031 · 17:00–18:00 SGT", or both dates across midnight. The
// response also carries periodStart and periodEnd as instants.
const SINGAPORE = "Asia/Singapore";
const dateFormat = new Intl.DateTimeFormat("en-SG", { timeZone: SINGAPORE, weekday: "short", day: "numeric", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-SG", { timeZone: SINGAPORE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const formatPeriod = (start, end) => {
  const from = new Date(start);
  const to = new Date(end);
  if (dateFormat.format(from) === dateFormat.format(to)) {
    return `${dateFormat.format(from)} · ${timeFormat.format(from)}–${timeFormat.format(to)} SGT`;
  }
  return `${dateFormat.format(from)} ${timeFormat.format(from)} – ${dateFormat.format(to)} ${timeFormat.format(to)} SGT`;
};

// SPM-52 AC7: the message names the committed quantity and period.
const quantityCommittedMessage = ({ committedQuantity, periodStart, periodEnd }) =>
  `${committedQuantity} unit${committedQuantity === 1 ? " is" : "s are"} unavailable during ${formatPeriod(periodStart, periodEnd)}, `
  + `so the total cannot be lower than ${committedQuantity}.`;

const stockExceededMessage = ({ availableQuantity, periodStart, periodEnd }) =>
  `Only ${availableQuantity} unit${availableQuantity === 1 ? " is" : "s are"} left to mark unavailable during `
  + `${formatPeriod(periodStart, periodEnd)}. Unavailable stock cannot exceed the total.`;

const upcomingRequestsMessage = ({ upcomingCount }) =>
  `This equipment is requested by ${upcomingCount} upcoming event${upcomingCount === 1 ? "" : "s"}. `
  + "Confirm to deactivate it; existing requests are kept.";

const handleError = async (error, res, next, equipmentId) => {
  if (error.name !== "EquipmentError") return next(error);
  if (error.code === "VALIDATION_FAILED") return validationFailed(res, error.fields || {});
  if (error.code === "EQUIPMENT_NAME_TAKEN") {
    return sendError(res, 409, error.code, MESSAGES.nameTaken, { fields: { name: MESSAGES.nameTaken } });
  }
  if (error.code === "EQUIPMENT_VERSION_CONFLICT") {
    // SPM-52 AC6: the refusal carries the current values, record and details, so
    // the client can show them before reloading.
    const [current, currentDetails] = equipmentId
      ? await Promise.all([equipmentModel.findEquipmentSummary(equipmentId), equipmentModel.findCurrentDetails(equipmentId)])
      : [null, null];
    return sendError(res, 409, error.code, "This equipment was changed after you loaded it. Review the current values, then try again.", {
      current,
      currentDetails,
    });
  }
  if (error.code === "EQUIPMENT_QUANTITY_COMMITTED") {
    const message = quantityCommittedMessage(error.detail);
    return sendError(res, 409, error.code, message, { ...error.detail, fields: { totalQuantity: message } });
  }
  if (error.code === "EQUIPMENT_STOCK_EXCEEDED") {
    const message = stockExceededMessage(error.detail);
    return sendError(res, 409, error.code, message, { ...error.detail, fields: { quantity: message } });
  }
  if (error.code === "EQUIPMENT_HAS_UPCOMING_REQUESTS") {
    return sendError(res, 409, error.code, upcomingRequestsMessage(error.detail), error.detail);
  }
  const [status, message] = DOMAIN_ERRORS[error.code] || [];
  return status ? sendError(res, status, error.code, message) : next(error);
};

// ---------- reads ----------

const listEquipment = async (req, res, next) => {
  const { filters, fields } = validateEquipmentListQuery(req.query);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    return res.status(200).json(await equipmentModel.listEquipment(filters, req.pagination));
  } catch (err) {
    return next(err);
  }
};

const listEquipmentOptions = async (req, res, next) => {
  try {
    return res.status(200).json(await equipmentModel.listEquipmentOptions());
  } catch (err) {
    return next(err);
  }
};

const getEquipment = async (req, res, next) => {
  const equipmentId = parseId(req.params.equipmentId);
  if (!equipmentId) return equipmentNotFound(res);
  try {
    const result = await equipmentModel.getEquipment(equipmentId);
    if (!result) return equipmentNotFound(res);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
};

// ---------- catalogue writes ----------

const createEquipment = async (req, res, next) => {
  const { values, fields } = validateEquipmentCreate(req.body);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const { equipment } = await equipmentModel.createEquipment(req.user.user_id, values);
    return res.status(201).json({ message: "Equipment created.", equipment });
  } catch (err) {
    return handleError(err, res, next);
  }
};

const updateEquipment = async (req, res, next) => {
  const equipmentId = parseId(req.params.equipmentId);
  if (!equipmentId) return equipmentNotFound(res);
  const { values, fields, version } = validateEquipmentUpdate(req.body);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const { equipment, changed } = await equipmentModel.updateEquipment(req.user.user_id, equipmentId, version, values);
    return res.status(200).json({ message: changed ? "Equipment updated." : "No changes to save.", equipment, changed });
  } catch (err) {
    return handleError(err, res, next, equipmentId);
  }
};

const changeEquipmentStatus = async (req, res, next) => {
  const equipmentId = parseId(req.params.equipmentId);
  if (!equipmentId) return equipmentNotFound(res);
  const { values, fields } = validateEquipmentStatusChange(req.body);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const { equipment, changed, upcomingRequests } = await equipmentModel.setEquipmentActive(req.user.user_id, equipmentId, values);
    let message = "No changes to save.";
    if (changed) message = values.active ? "Equipment reactivated." : "Equipment deactivated.";
    return res.status(200).json({ message, equipment, changed, upcomingRequests });
  } catch (err) {
    return handleError(err, res, next, equipmentId);
  }
};

// ---------- unavailable stock (SPM-52 AC8) ----------

const recordUnavailability = async (req, res, next) => {
  const equipmentId = parseId(req.params.equipmentId);
  if (!equipmentId) return equipmentNotFound(res);
  const { values, fields } = validateUnavailabilityCreate(req.body);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const result = await equipmentModel.recordUnavailability(req.user.user_id, equipmentId, values);
    return res.status(201).json({ message: "Unavailable stock recorded.", ...result });
  } catch (err) {
    return handleError(err, res, next, equipmentId);
  }
};

const updateUnavailability = async (req, res, next) => {
  const equipmentId = parseId(req.params.equipmentId);
  const unavailabilityId = parseId(req.params.unavailabilityId);
  if (!equipmentId) return equipmentNotFound(res);
  if (!unavailabilityId) return unavailabilityNotFound(res);
  try {
    // The stored period decides whether a change to one end still runs forwards.
    const current = await equipmentModel.findUnavailabilityRow(equipmentId, unavailabilityId);
    if (!current) return unavailabilityNotFound(res);
    const { values, fields, version } = validateUnavailabilityUpdate(req.body, current);
    if (hasErrors(fields)) return validationFailed(res, fields);

    const result = await equipmentModel.updateUnavailability({
      actorId: req.user.user_id,
      equipmentId,
      unavailabilityId,
      version,
      changes: values,
    });
    return res.status(200).json({ message: result.changed ? "Unavailable stock updated." : "No changes to save.", ...result });
  } catch (err) {
    return handleError(err, res, next, equipmentId);
  }
};

const endUnavailability = async (req, res, next) => {
  const equipmentId = parseId(req.params.equipmentId);
  const unavailabilityId = parseId(req.params.unavailabilityId);
  if (!equipmentId) return equipmentNotFound(res);
  if (!unavailabilityId) return unavailabilityNotFound(res);
  const { version, fields } = validateVersionOnly(req.body);
  if (hasErrors(fields)) return validationFailed(res, fields);
  try {
    const result = await equipmentModel.endUnavailability({ actorId: req.user.user_id, equipmentId, unavailabilityId, version });
    const message = result.unavailability.status === UNAVAILABILITY_STATUS.CANCELLED ? "Unavailable stock cancelled." : "Unavailable stock ended.";
    return res.status(200).json({ message, ...result });
  } catch (err) {
    return handleError(err, res, next, equipmentId);
  }
};

module.exports = {
  listEquipment,
  listEquipmentOptions,
  getEquipment,
  createEquipment,
  updateEquipment,
  changeEquipmentStatus,
  recordUnavailability,
  updateUnavailability,
  endUnavailability,
};
