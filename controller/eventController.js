const eventModel = require("../model/eventModel");
const activityModel = require("../model/activityModel");
const { getEventAccess } = require("../middleware/authorize");
const {
  validateDraft,
  validateSubmission,
  validateRequirements,
  validateOrdinaryFields,
  hasErrors,
  toWholeNumber,
} = require("../validators/eventValidator");
const { EVENT_STATUS, EVENT_RELATIONSHIP, EVENT_FIELD_GROUPS } = require("../config/eventConstants");

const EVENT_STATUSES = Object.values(EVENT_STATUS);
const CLOSED_STATUSES = [EVENT_STATUS.COMPLETED, EVENT_STATUS.REJECTED, EVENT_STATUS.CANCELLED];
const KNOWN_EVENT_FIELDS = new Set(Object.values(EVENT_FIELD_GROUPS).flat());
const SYSTEM_FIELDS = new Set(EVENT_FIELD_GROUPS.SYSTEM);
const MAX_EVENT_ID = 2147483647;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const IDEMPOTENCY_KEY_MESSAGE =
  "Send an Idempotency-Key header of 8-128 letters, digits, '.', '_', ':' or '-' (a UUID works).";
const VERSION_MESSAGE = "Send the version of the event you loaded.";

const DOMAIN_ERRORS = Object.freeze({
  EVENT_NOT_FOUND: [404, "Event request not found."],
  EVENT_NOT_DRAFT: [409, "Only draft requests can be changed or submitted."],
  NO_ELIGIBLE_COORDINATOR: [409, "No coordinator is currently available. Your request was not submitted."],
  IDEMPOTENCY_KEY_REUSED: [409, "This Idempotency-Key was already used for a different request."],
  IDEMPOTENCY_IN_PROGRESS: [409, "This request is still being processed. Try again shortly."],
  EVENT_VERSION_CONFLICT: [409, "This event was changed after you loaded it. Review the current details, then try again."],
  EDIT_REQUIRES_CHANGE_REQUEST: [403, "A submitted request cannot be edited directly. Request a change instead."],
  EVENT_READ_ONLY: [403, "You can view this request, but only its owner can ask for changes."],
  EVENT_NOT_EDITABLE_IN_STATUS: [403, "This event cannot be edited in its current status."],
  FIELD_NOT_EDITABLE: [403, "You cannot change some of these fields. Nothing was saved."],
});

// ---------- helpers ----------

// Same shape as every other API error: { error, code } plus fields for validation.
const sendError = (res, status, code, error, fields) =>
  res.status(status).json(fields ? { error, code, fields } : { error, code });

const sendDomainError = (res, code, fields) => sendError(res, DOMAIN_ERRORS[code][0], code, DOMAIN_ERRORS[code][1], fields);

const validationFailed = (res, fields) =>
  sendError(
    res,
    400,
    "VALIDATION_FAILED",
    hasErrors(fields) ? "Please correct the highlighted fields." : "Some values could not be saved. Check the form and try again.",
    fields
  );

const eventNotFound = (res) => sendDomainError(res, "EVENT_NOT_FOUND");

const handleError = (error, res, next) => {
  if (error.name === "EventRequestError") {
    if (error.code === "VALIDATION_FAILED") return validationFailed(res, error.fields || {});
    if (error.code === "INVALID_CURSOR") return validationFailed(res, { cursor: "Invalid page cursor." });
    if (error.code === "IDEMPOTENCY_KEY_REQUIRED") return validationFailed(res, { idempotencyKey: IDEMPOTENCY_KEY_MESSAGE });
    if (DOMAIN_ERRORS[error.code]) return sendDomainError(res, error.code);
  }
  return next(error);
};

// IDs that cannot exist are "not found", like IDs the user may not see.
const parseEventId = (value) =>
  /^[1-9]\d{0,9}$/.test(value) && Number(value) <= MAX_EVENT_ID ? Number(value) : null;

const readIdempotencyKey = (req) => {
  const key = req.get("Idempotency-Key");
  return typeof key === "string" && IDEMPOTENCY_KEY.test(key) ? key : null;
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Returns field errors for the request shape itself. Object.fromEntries keeps a
// client-sent "__proto__" key as plain data.
const checkRequestBody = (body, { allowAutoSave = false, allowVersion = false } = {}) => {
  if (!isPlainObject(body)) {
    return { body: "Send the event request as a JSON object." };
  }
  const fields = Object.fromEntries(
    eventModel
      .getUnsupportedInputFields(body, { allowAutoSave, allowVersion })
      .slice(0, 10)
      .map((field) => [field.slice(0, 60), "This field cannot be set."])
  );
  if (allowAutoSave && body.isAutoSave !== undefined && typeof body.isAutoSave !== "boolean") {
    fields.isAutoSave = "Auto-save flag must be true or false.";
  }
  return fields;
};

// Existing saved values + newly sent values, used to validate the complete picture.
const mergeWithExisting = (existingRow, input) => ({
  ...eventModel.pickEventInput(eventModel.toApi(existingRow)),
  ...input,
});

const validateWith = async (validate, input) => {
  const context = await eventModel.findValidationContext(input);
  return {
    ...validate(input, { allowedLayouts: context.allowedLayouts }),
    ...validateRequirements(input, context),
  };
};

const markReplay = (res, result) => {
  if (result.replayed) res.set("Idempotent-Replayed", "true");
};

// The event and what this user may do with it, or null when it is outside their
// viewing scope. Callers answer "not found" for null, never "forbidden", so the
// response does not confirm that the event exists (SPM-33 AC1, AC6).
const loadEventForViewer = async (eventId, user) => {
  const event = await eventModel.findEventForViewer(eventId, user);
  if (!event) return null;
  const access = getEventAccess(user, event);
  return access.relationship ? { event, access } : null;
};

// Why a user who can see the event cannot edit it at all, or null when they can.
const getEditDenial = (access, event) => {
  if (access.canEdit) return null;
  if (access.relationship === EVENT_RELATIONSHIP.ORGANISATION_MEMBER) return "EVENT_READ_ONLY";
  if (access.relationship === EVENT_RELATIONSHIP.OWNER && !CLOSED_STATUSES.includes(event.status)) {
    return "EDIT_REQUIRES_CHANGE_REQUEST";
  }
  return "EVENT_NOT_EDITABLE_IN_STATUS";
};

// Event fields this user may not change now. One of them rejects the whole
// request, including fields the interface hides or disables (SPM-33 AC6).
const getFieldDenials = (body, access) => {
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!KNOWN_EVENT_FIELDS.has(key) || access.editableFields.includes(key)) continue;
    if (SYSTEM_FIELDS.has(key)) {
      fields[key] = "This field is set by the system.";
    } else if (access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR) {
      fields[key] = "This field can only be changed through a change request.";
    } else {
      fields[key] = "This field cannot be set.";
    }
  }
  return fields;
};

const readVersion = (body, required, errors) => {
  if (body.version === undefined && !required) return null;
  const version = toWholeNumber(body.version);
  if (!Number.isInteger(version) || version < 1 || version > MAX_EVENT_ID) {
    errors.version = VERSION_MESSAGE;
    return null;
  }
  return version;
};

// The save was made against an older version: nothing changed, and the current
// values are returned so the user can review them before trying again (AC7).
const sendVersionConflict = async (req, res, eventId) => {
  const current = await loadEventForViewer(eventId, req.user);
  if (!current) return eventNotFound(res);
  return res.status(409).json({
    error: DOMAIN_ERRORS.EVENT_VERSION_CONFLICT[1],
    code: "EVENT_VERSION_CONFLICT",
    event: eventModel.toEventView(current.event, req.user, current.access),
  });
};

// One save path for every direct edit (SPM-33 AC2-AC7). Checks run in the order of
// the AC6 table: viewing scope (404), permission to make this edit (403), input
// (400), then the write, where the database rechecks relationship, status and
// version under the event row lock (409 for a stale version).
const saveEventEdit = async (req, res, next, { allowAutoSave, requireVersion, requireIdempotencyKey }) => {
  const eventId = parseEventId(req.params.id);
  if (!eventId) return eventNotFound(res);

  try {
    const visible = await loadEventForViewer(eventId, req.user);
    if (!visible) return eventNotFound(res);
    const { event: existing, access } = visible;

    const denial = getEditDenial(access, existing);
    if (denial) return sendDomainError(res, denial);

    const body = req.body ?? {};
    const deniedFields = isPlainObject(body) ? getFieldDenials(body, access) : {};
    if (hasErrors(deniedFields)) return sendDomainError(res, "FIELD_NOT_EDITABLE", deniedFields);

    const requestErrors = checkRequestBody(body, { allowAutoSave, allowVersion: true });
    if (requestErrors.body) return validationFailed(res, requestErrors);
    const expectedVersion = readVersion(body, requireVersion, requestErrors);
    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey && (requireIdempotencyKey || req.get("Idempotency-Key") !== undefined)) {
      requestErrors.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
    }
    if (hasErrors(requestErrors)) return validationFailed(res, requestErrors);

    const input = eventModel.pickEventInput(body);
    const isCoordinatorEdit = access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR;
    const isAutoSave = allowAutoSave && body.isAutoSave === true;
    let result;
    if (isCoordinatorEdit) {
      if (Object.keys(input).length === 0) return validationFailed(res, { body: "Send at least one field to change." });
      const errors = validateOrdinaryFields(input);
      if (hasErrors(errors)) return validationFailed(res, errors);
      result = await eventModel.updateEventDetails({
        actorId: req.user.user_id,
        eventId,
        input,
        expectedVersion,
        idempotencyKey,
      });
    } else {
      const errors = await validateWith(validateDraft, mergeWithExisting(existing, input));
      if (hasErrors(errors)) return validationFailed(res, errors);
      result = await eventModel.saveDraft({
        organiserId: req.user.user_id,
        eventId,
        input,
        isAutoSave,
        idempotencyKey,
        expectedVersion,
      });
    }

    markReplay(res, result);
    const saved = { ...existing, ...result.event };
    const event = eventModel.toEventView(saved, req.user, getEventAccess(req.user, saved));
    if (isCoordinatorEdit) return res.status(200).json({ message: "Event details updated.", event });
    return res.status(200).json({
      message: isAutoSave ? "Draft auto-saved." : "Draft saved successfully.",
      event,
      savedAt: result.event.updated_at, // frontend formats this as "Last auto-saved at HH:MM:SS AM/PM"
    });
  } catch (error) {
    if (error.name === "EventRequestError" && error.code === "EVENT_VERSION_CONFLICT") {
      return sendVersionConflict(req, res, eventId).catch(next);
    }
    // The request was submitted between the read above and the write.
    if (error.name === "EventRequestError" && error.code === "EVENT_NOT_DRAFT") {
      return sendDomainError(res, "EDIT_REQUIRES_CHANGE_REQUEST");
    }
    return handleError(error, res, next);
  }
};

// ---------- handlers ----------

// POST /api/events — SPM-35: create and submit in one step (AC1-AC4, TC-001-003)
const createAndSubmit = async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const requestErrors = checkRequestBody(body);
    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey) requestErrors.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
    if (hasErrors(requestErrors)) return validationFailed(res, requestErrors);

    const input = eventModel.pickEventInput(body);
    const errors = await validateWith(validateSubmission, input);
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = await eventModel.submitEvent({ organiserId: req.user.user_id, input, idempotencyKey });
    markReplay(res, result);
    return res.status(201).json({
      message: "Your event request has been submitted successfully.",
      event: eventModel.toApi(result.event),
    });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// POST /api/events/drafts — SPM-37 Scenario 1 (and the first auto-save)
const createDraft = async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const requestErrors = checkRequestBody(body);
    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey) requestErrors.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
    if (hasErrors(requestErrors)) return validationFailed(res, requestErrors);

    const input = eventModel.pickEventInput(body);
    const errors = await validateWith(validateDraft, input);
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = await eventModel.saveDraft({ organiserId: req.user.user_id, input, idempotencyKey });
    markReplay(res, result);
    return res.status(201).json({
      message: "Draft saved successfully.",
      event: eventModel.toApi(result.event),
      savedAt: result.event.updated_at,
    });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// PUT /api/events/:id/draft — SPM-37 Scenarios 1 & 3 (manual save and auto-save)
// The 30-second idle timer sends { ...fields, isAutoSave: true }. "version" and
// the Idempotency-Key header are optional here so existing clients keep working.
const updateDraft = async (req, res, next) =>
  saveEventEdit(req, res, next, { allowAutoSave: true, requireVersion: false, requireIdempotencyKey: false });

// PUT /api/events/:id — SPM-33: the owner's manual draft save or the assigned
// coordinator's edit of ordinary fields, decided by the field edit matrix.
const updateEventDetails = async (req, res, next) =>
  saveEventEdit(req, res, next, { allowAutoSave: false, requireVersion: true, requireIdempotencyKey: true });

// PUT /api/events/:id/submit — SPM-37 Scenario 4 (submit a saved draft)
const submitDraft = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const body = req.body ?? {};
    const requestErrors = checkRequestBody(body);
    if (hasErrors(requestErrors)) return validationFailed(res, requestErrors);

    const existing = await eventModel.findOwnEvent(eventId, req.user.user_id);
    if (!existing) return eventNotFound(res);
    if (existing.status !== EVENT_STATUS.DRAFT) {
      return sendDomainError(res, "EVENT_NOT_DRAFT");
    }

    const input = eventModel.pickEventInput(body);
    const errors = await validateWith(validateSubmission, mergeWithExisting(existing, input));
    // Nothing is written on failure, so the status stays DRAFT (SPM-37 negative TC).
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = await eventModel.submitEvent({ organiserId: req.user.user_id, eventId, input });
    return res.status(200).json({
      message: "Your event request has been submitted successfully.",
      event: eventModel.toApi(result.event),
    });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/events/mine?status=DRAFT — dashboard lists ("My Drafts" / "My Requests")
const listMyEventRequests = async (req, res, next) => {
  try {
    const { status } = req.query;
    if (status !== undefined && !EVENT_STATUSES.includes(status)) {
      return validationFailed(res, { status: "Unknown status filter." });
    }
    const { events, nextCursor } = await eventModel.findOrganiserEventRequests(req.user, {
      ...req.pagination,
      status: status ?? null,
    });
    return res.status(200).json({ events, nextCursor });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/events/:id — SPM-33 AC1: the event as this user may see it. Read-only:
// opening an event never changes its status.
const getEventRequest = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const visible = await loadEventForViewer(eventId, req.user);
    if (!visible) return eventNotFound(res);
    return res.status(200).json({ event: eventModel.toEventView(visible.event, req.user, visible.access) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/events/:id/history — SPM-33 AC8: change history, filtered by audience.
// Being able to view the event does not by itself show staff-only entries, or
// entries from before submission, which are for the owner alone.
const getEventHistory = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const visible = await loadEventForViewer(eventId, req.user);
    if (!visible) return eventNotFound(res);
    const { history, nextCursor } = await activityModel.findEventHistory(eventId, {
      ...req.pagination,
      audiences: visible.access.historyAudiences,
    });
    return res.status(200).json({ history, nextCursor });
  } catch (error) {
    return handleError(error, res, next);
  }
};

module.exports = {
  createAndSubmit,
  createDraft,
  updateDraft,
  updateEventDetails,
  submitDraft,
  listMyEventRequests,
  getEventRequest,
  getEventHistory,
};
