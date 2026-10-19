const eventModel = require("../model/eventModel");
const activityModel = require("../model/activityModel");
const { getEventAccess, getEditDenial, loadEventForViewer, EVENT_NOT_FOUND } = require("../middleware/authorize");
const { parseEventId } = require("../middleware/validate");
const {
  validateDraft,
  validateSubmission,
  validateRequirements,
  validateOrdinaryFields,
  hasErrors,
  toWholeNumber,
  MAX_INTEGER,
} = require("../validators/eventValidator");
const {
  EVENT_STATUS,
  EVENT_RELATIONSHIP,
  EVENT_FIELD_GROUPS,
  LABEL_STATUSES,
  LIFECYCLE_ACTIONS,
  READINESS_MESSAGES,
} = require("../config/eventConstants");

const EVENT_STATUSES = Object.values(EVENT_STATUS);
const KNOWN_EVENT_FIELDS = new Set(Object.values(EVENT_FIELD_GROUPS).flat());
const SYSTEM_FIELDS = new Set(EVENT_FIELD_GROUPS.SYSTEM);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const IDEMPOTENCY_KEY_MESSAGE =
  "Send an Idempotency-Key header of 8-128 letters, digits, '.', '_', ':' or '-' (a UUID works).";
const VERSION_MESSAGE = "Send the version of the event you loaded.";

const DOMAIN_ERRORS = Object.freeze({
  EVENT_NOT_FOUND: [404, EVENT_NOT_FOUND.error],
  EVENT_NOT_DRAFT: [409, "Only draft requests can be changed or submitted."],
  NO_ELIGIBLE_COORDINATOR: [409, "No coordinator is currently available. Your request was not submitted."],
  IDEMPOTENCY_KEY_REUSED: [409, "This Idempotency-Key was already used for a different request."],
  IDEMPOTENCY_IN_PROGRESS: [409, "This request is still being processed. Try again shortly."],
  EVENT_VERSION_CONFLICT: [409, "This event was changed after you loaded it. Review the current details, then try again."],
  EDIT_REQUIRES_CHANGE_REQUEST: [403, "A submitted request cannot be edited directly. Request a change instead."],
  EVENT_READ_ONLY: [403, "You can view this request, but only its owner can ask for changes."],
  EVENT_NOT_EDITABLE_IN_STATUS: [403, "This event cannot be edited in its current status."],
  FIELD_NOT_EDITABLE: [403, "You cannot change some of these fields. Nothing was saved."],
  INVALID_COORDINATOR: [409, "The selected user is not an active event coordinator."],
  COORDINATOR_CONFLICT: [409, "The selected coordinator is already assigned to an overlapping event."],
  COORDINATOR_UNCHANGED: [409, "The selected coordinator is already assigned to this event."],
  ASSIGNMENT_CHANGED: [409, "This event was reassigned by someone else. Refresh and try again."],
  EVENT_NOT_REASSIGNABLE: [404, "Event request not found."],
  FORBIDDEN: [403, "You do not have permission to access this resource."],
  TRANSITION_NOT_ALLOWED: [403, "This action is not allowed for this event in its current status."],
  READINESS_BLOCKED: [409, "The event is not ready yet. Resolve the listed items, then try again."],
  SAFETY_APPROVAL_REQUIRED: [409, "The event needs a safety approval for its current arrangements before it can be confirmed."],
  EVENT_NOT_ENDED: [409, "The event can be completed only after it has ended."],
  COORDINATOR_INVARIANT: [409, "The event's coordinator assignment does not allow this action. Refresh and try again."],
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
  if (!Number.isInteger(version) || version < 1 || version > MAX_INTEGER) {
    errors.version = VERSION_MESSAGE;
    return null;
  }
  return version;
};

// Everything in a save request besides the event fields: the version the client
// loaded, its idempotency key and whether this is an auto-save. "rules" says what
// the route accepts and requires. The values are only meaningful when "errors",
// the problems with the request itself, is empty.
const readSaveRequest = (req, body, { allowAutoSave, requireVersion, requireIdempotencyKey }) => {
  const errors = checkRequestBody(body, { allowAutoSave, allowVersion: true });
  if (errors.body) return { errors };

  const expectedVersion = readVersion(body, requireVersion, errors);
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey && (requireIdempotencyKey || req.get("Idempotency-Key") !== undefined)) {
    errors.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
  }
  return { errors, expectedVersion, idempotencyKey, isAutoSave: allowAutoSave && body.isAutoSave === true };
};

// A coordinator's edit must change at least one ordinary field (SPM-33 AC4).
const validateCoordinatorEdit = (input) =>
  Object.keys(input).length === 0 ? { body: "Send at least one field to change." } : validateOrdinaryFields(input);

// The owner's draft is validated as a whole: the saved values plus the ones sent.
const validateOwnerDraft = (existing, input) => validateWith(validateDraft, mergeWithExisting(existing, input));

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
// the AC6 table: viewing scope (404, by requireVisibleEvent before this), permission
// to make this edit (403), input (400), then the write, where the database rechecks
// relationship, status and version under the event row lock (409 for a stale version).
const saveEventEdit = async (req, res, next, rules) => {
  const { eventId, event: existing, access } = req.visibleEvent;
  const actorId = req.user.user_id;

  try {
    const denial = getEditDenial(access, existing);
    if (denial) return sendDomainError(res, denial);

    const body = req.body ?? {};
    const deniedFields = isPlainObject(body) ? getFieldDenials(body, access) : {};
    if (hasErrors(deniedFields)) return sendDomainError(res, "FIELD_NOT_EDITABLE", deniedFields);

    const { errors: requestErrors, expectedVersion, idempotencyKey, isAutoSave } = readSaveRequest(req, body, rules);
    if (hasErrors(requestErrors)) return validationFailed(res, requestErrors);

    const input = eventModel.pickEventInput(body);
    const isCoordinatorEdit = access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR;
    const errors = isCoordinatorEdit ? validateCoordinatorEdit(input) : await validateOwnerDraft(existing, input);
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = isCoordinatorEdit
      ? await eventModel.updateEventDetails({ actorId, eventId, input, expectedVersion, idempotencyKey })
      : await eventModel.saveDraft({ organiserId: actorId, eventId, input, isAutoSave, idempotencyKey, expectedVersion });

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

// GET /api/events/mine?status=DRAFT or ?label=Draft — dashboard lists ("My Drafts" /
// "My Requests"). A label is expanded to its statuses here (SPM-173 AC6); the status
// filter stays for the current organiser pages until they move to labels.
const listMyEventRequests = async (req, res, next) => {
  try {
    const { status, label } = req.query;
    if (status !== undefined && label !== undefined) {
      return validationFailed(res, { label: "Filter by status or by label, not both." });
    }
    if (status !== undefined && !EVENT_STATUSES.includes(status)) {
      return validationFailed(res, { status: "Unknown status filter." });
    }
    if (label !== undefined && !Object.prototype.hasOwnProperty.call(LABEL_STATUSES, label)) {
      return validationFailed(res, { label: "Unknown label filter." });
    }
    const { events, nextCursor } = await eventModel.findOrganiserEventRequests(req.user, {
      ...req.pagination,
      status: status ?? null,
      ...(label === undefined ? {} : { statuses: [...LABEL_STATUSES[label]] }),
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
    const { event, access } = req.visibleEvent;
    return res.status(200).json({ event: eventModel.toEventView(event, req.user, access) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/events/:id/history — SPM-33 AC8: change history, filtered by audience.
// Being able to view the event does not by itself show staff-only entries, or
// entries from before submission, which are for the owner alone.
const getEventHistory = async (req, res, next) => {
  try {
    const { eventId, access } = req.visibleEvent;
    const { history, nextCursor } = await activityModel.findEventHistory(eventId, {
      ...req.pagination,
      audiences: access.historyAudiences,
    });
    return res.status(200).json({ history, nextCursor });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const listAssignedEvents = async (req, res, next) => {
  try {
    const events = await eventModel.findCoordinatorEvents(req.user.user_id);
    return res.status(200).json({ events });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const assignCoordinator = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const body = req.body;
    if (
      !body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, "coordinatorId") ||
      !Number.isSafeInteger(body.coordinatorId) || body.coordinatorId < 1
    ) {
      return validationFailed(res, { coordinatorId: "Send a positive integer coordinatorId." });
    }
    const assignedEvent = await eventModel.assignCoordinator({ eventId, coordinatorId: body.coordinatorId, leadId: req.user.user_id });
    return res.status(200).json({ event: eventModel.toApi(assignedEvent) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const listLeadAssignments = async (req, res, next) => {
  try {
    const assignments = await eventModel.findLeadAssignments();
    return res.status(200).json({ assignments });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const listUnassignedEvents = async (req, res, next) => {
  try {
    const events = await eventModel.findUnassignedSubmittedEvents();
    return res.status(200).json({ events: events.map((event) => eventModel.toApi(event)) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const getCoordinatorAvailability = async (req, res, next) => {
  try {
    const coordinators = await eventModel.findCoordinatorAvailability();
    return res.status(200).json({ coordinators });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const reassignCoordinator = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(body, "coordinatorId") ||
      !Number.isSafeInteger(body.coordinatorId) ||
      body.coordinatorId < 1 ||
      !Object.prototype.hasOwnProperty.call(body, "expectedCoordinatorId") ||
      !Number.isSafeInteger(body.expectedCoordinatorId) ||
      body.expectedCoordinatorId < 1
    ) {
      return validationFailed(res, {
        coordinatorId: "Send a positive integer coordinatorId.",
        expectedCoordinatorId: "Send the coordinatorId currently shown as assigned.",
      });
    }

    const result = await eventModel.reassignCoordinator({
      eventId,
      coordinatorId: body.coordinatorId,
      expectedCoordinatorId: body.expectedCoordinatorId,
      leadId: req.user.user_id,
    });
    return res.status(200).json({
      message: "Event coordinator reassigned successfully.",
      event: result.event,
      coordinator: result.coordinator,
    });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// ---------- SPM-173 lifecycle actions ----------

const toReadinessFailures = (codes) =>
  codes.map((code) => ({ code, message: READINESS_MESSAGES[code] || "This condition is not met yet." }));

// The body carries only the version of the event the coordinator loaded, so an
// action taken from an outdated page is refused (409) instead of applied.
const readActionRequest = (req) => {
  const body = req.body ?? {};
  if (!isPlainObject(body)) return { errors: { body: "Send the request as a JSON object." } };
  const errors = Object.fromEntries(
    Object.keys(body)
      .filter((key) => key !== "version")
      .slice(0, 10)
      .map((key) => [key.slice(0, 60), "This field cannot be set."])
  );
  const expectedVersion = readVersion(body, true, errors);
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey && req.get("Idempotency-Key") !== undefined) errors.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
  return { errors, expectedVersion, idempotencyKey };
};

// POST /api/events/:id/submit-for-safety-review, /confirm, /start-preparation and
// /complete — SPM-173 AC9-AC12. Outside the coordinator's scope is 404 (before
// this, in requireVisibleEvent); then 400 for the request itself. The database
// decides the rest under the event lock: 403 for an action the status does not
// allow (naming the status, AC3), 409 for a stale version (AC5) or an unmet
// condition (readiness, safety approval, event not ended).
const lifecycleAction = (action) => async (req, res, next) => {
  const { eventId } = req.visibleEvent;
  try {
    const { errors, expectedVersion, idempotencyKey } = readActionRequest(req);
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = await eventModel.runLifecycleAction({
      action,
      eventId,
      actorId: req.user.user_id,
      expectedVersion,
      idempotencyKey,
    });
    markReplay(res, result);
    const current = await loadEventForViewer(eventId, req.user);
    if (!current) return eventNotFound(res);
    return res.status(200).json({
      message: LIFECYCLE_ACTIONS[action].message,
      event: eventModel.toEventView(current.event, req.user, current.access),
    });
  } catch (error) {
    if (error.name === "EventRequestError" && error.code === "EVENT_VERSION_CONFLICT") {
      return sendVersionConflict(req, res, eventId).catch(next);
    }
    if (error.name === "EventRequestError" && error.code === "TRANSITION_NOT_ALLOWED") {
      const currentStatus = error.currentStatus ?? null;
      return res.status(403).json({
        error: currentStatus
          ? `This action is not allowed while the event is in ${currentStatus}.`
          : DOMAIN_ERRORS.TRANSITION_NOT_ALLOWED[1],
        code: "TRANSITION_NOT_ALLOWED",
        currentStatus,
      });
    }
    if (error.name === "EventRequestError" && error.code === "READINESS_BLOCKED") {
      return res.status(409).json({
        error: DOMAIN_ERRORS.READINESS_BLOCKED[1],
        code: "READINESS_BLOCKED",
        failures: toReadinessFailures(error.failures || []),
      });
    }
    return handleError(error, res, next);
  }
};

const submitForSafetyReview = lifecycleAction("SUBMIT_FOR_SAFETY_REVIEW");
const confirmEvent = lifecycleAction("CONFIRM");
const startPreparation = lifecycleAction("START_PREPARATION");
const completeEvent = lifecycleAction("COMPLETE");

// GET /api/events/:id/readiness — SPM-173 AC8: what still blocks safety review and
// confirmation, one entry per failing condition. Read-only; the actions recheck it.
const getEventReadiness = async (req, res, next) => {
  try {
    const readiness = await eventModel.getEventReadiness({ eventId: req.visibleEvent.eventId, actorId: req.user.user_id });
    return res.status(200).json({ ...readiness, failures: toReadinessFailures(readiness.failures) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const getRequestOptions = async (req, res, next) => {
  try { res.status(200).json(await eventModel.findRequestOptions()); }
  catch (error) { return next(error); }
};

module.exports = {
  getRequestOptions,
  createAndSubmit,
  createDraft,
  updateDraft,
  updateEventDetails,
  submitDraft,
  listMyEventRequests,
  getEventRequest,
  getEventHistory,
  listAssignedEvents,
  assignCoordinator,
  listLeadAssignments,
  listUnassignedEvents,
  getCoordinatorAvailability,
  reassignCoordinator,
  getEventReadiness,
  submitForSafetyReview,
  confirmEvent,
  startPreparation,
  completeEvent,
};
