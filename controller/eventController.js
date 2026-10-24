const eventModel = require("../model/eventModel");
const activityModel = require("../model/activityModel");
const { getEventAccess, getEditDenial, loadEventForViewer, EVENT_NOT_FOUND } = require("../middleware/authorize");
const { parseEventId } = require("../middleware/validate");
const {
  validateDraft,
  validateSubmission,
  validateRequirements,
  validateOrdinaryFields,
  validateClarificationText,
  hasErrors,
  toWholeNumber,
  MAX_INTEGER,
  MESSAGES,
} = require("../validators/eventValidator");
const { USER_ROLES } = require("../config/roles");
const {
  EVENT_STATUS,
  EVENT_RELATIONSHIP,
  EVENT_FIELD_GROUPS,
  LABEL_STATUSES,
  LIFECYCLE_ACTIONS,
  READINESS_MESSAGES,
  AMENDMENT_FIELDS,
} = require("../config/eventConstants");


const EVENT_STATUSES = Object.values(EVENT_STATUS);
const KNOWN_EVENT_FIELDS = new Set(Object.values(EVENT_FIELD_GROUPS).flat());
const SYSTEM_FIELDS = new Set(EVENT_FIELD_GROUPS.SYSTEM);
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const IDEMPOTENCY_KEY_MESSAGE =
  "Send an Idempotency-Key header of 8-128 letters, digits, '.', '_', ':' or '-' (a UUID works).";
const VERSION_MESSAGE = "Send the version of the event you loaded.";

const DOMAIN_ERRORS = Object.freeze({
  FORBIDDEN: [403, "You do not have permission to access this resource."],
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
  COORDINATOR_CONFLICT: [409, "The selected coordinator is unavailable during this event."],
  COORDINATOR_UNCHANGED: [409, "The selected coordinator is already assigned to this event."],
  ASSIGNMENT_CHANGED: [409, "This event was reassigned by someone else. Refresh and try again."],

  EVENT_NOT_REASSIGNABLE: [404, "Event request not found."],
  TRANSITION_NOT_ALLOWED: [403, "This action is not allowed for this event in its current status."],
  READINESS_BLOCKED: [409, "The event is not ready yet. Resolve the listed items, then try again."],
  SAFETY_APPROVAL_REQUIRED: [409, "The event needs a safety approval for its current arrangements before it can be confirmed."],
  EVENT_NOT_ENDED: [409, "The event can be completed only after it has ended."],
  COORDINATOR_INVARIANT: [409, "The event's coordinator assignment does not allow this action. Refresh and try again."],
  CLARIFICATION_NOT_OPEN: [409, "This request has no open clarification. Refresh to see its current status."],
  CLARIFICATION_NOT_FOUND: [404, "Clarification request not found."],
  CLARIFICATION_CLOSED: [409, "This clarification request is already complete. Refresh to see its current status."],
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
    hasErrors(fields)
      ? "Please correct the highlighted fields."
      : "Some values could not be saved. Check the form and try again.",
    fields,
  );


const eventNotFound = (res) =>
  sendError(res, 404, "EVENT_NOT_FOUND", DOMAIN_ERRORS.EVENT_NOT_FOUND[1]);

const handleError = (error, res, next) => {
  if (error.name === "EventRequestError") {
    if (error.code === "VALIDATION_FAILED") return validationFailed(res, error.fields || {});
    if (error.code === "INVALID_CURSOR") return validationFailed(res, { cursor: "Invalid page cursor." });
    if (error.code === "IDEMPOTENCY_KEY_REQUIRED") return validationFailed(res, { idempotencyKey: IDEMPOTENCY_KEY_MESSAGE });
    if (DOMAIN_ERRORS[error.code]) return sendDomainError(res, error.code, error.fields);

  }
  return next(error);
};


const readIdempotencyKey = (req) => {
  const key = req.get("Idempotency-Key");
  return typeof key === "string" && IDEMPOTENCY_KEY.test(key) ? key : null;
};

// A sent key must be well formed; a missing one is an error only when "required".
const readRequestIdempotencyKey = (req, required, errors) => {
  const idempotencyKey = readIdempotencyKey(req);
  if (!idempotencyKey && (required || req.get("Idempotency-Key") !== undefined)) {
    errors.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
  }
  return idempotencyKey;
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// The first ten unsupported fields, with shortened names. Object.fromEntries
// keeps a client-sent "__proto__" key as plain data.
const toUnsupportedFieldErrors = (fields) =>
  Object.fromEntries(fields.slice(0, 10).map((field) => [field.slice(0, 60), "This field cannot be set."]));

// Returns field errors for the request shape itself.
const checkRequestBody = (body, { allowAutoSave = false, allowVersion = false } = {}) => {
  if (!isPlainObject(body)) {
    return { body: "Send the event request as a JSON object." };
  }
  const fields = toUnsupportedFieldErrors(eventModel.getUnsupportedInputFields(body, { allowAutoSave, allowVersion }));
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
  const idempotencyKey = readRequestIdempotencyKey(req, requireIdempotencyKey, errors);
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

    const result = await eventModel.submitEvent({
      organiserId: req.user.user_id,
      input,
      idempotencyKey,
    });
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

    const result = await eventModel.saveDraft({
      organiserId: req.user.user_id,
      input,
      idempotencyKey,
    });
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

      return sendError(
        res,
        409,
        "EVENT_NOT_DRAFT",
        DOMAIN_ERRORS.EVENT_NOT_DRAFT[1],
      );

      return sendDomainError(res, "EVENT_NOT_DRAFT");

    }

    const input = eventModel.pickEventInput(body);
    const errors = await validateWith(
      validateSubmission,
      mergeWithExisting(existing, input),
    );
    // Nothing is written on failure, so the status stays DRAFT (SPM-37 negative TC).
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = await eventModel.submitEvent({
      organiserId: req.user.user_id,
      eventId,
      input,
    });
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

// GET /api/events/unassigned — coordinator lead assignment queue.
async function getUnassignedEvents(req, res, next) {
  try {
    const events = await eventModel.findUnassignedSubmittedEvents();
    return res.status(200).json({ events: events.map(eventModel.toUnassignedQueueItem) });
  } catch (err) {
    return next(err);
  }
}

const listAttendeeDiscovery = async (req, res, next) => {
  try {
    const { events, nextCursor } = await eventModel.findPublishedAttendeeEvents({ ...req.pagination });
    return res.status(200).json({ events, nextCursor });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const getAttendeeEventDetail = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);

    const event = await eventModel.findPublishedAttendeeEvent(eventId);
    if (!event) return eventNotFound(res);

    return res.status(200).json({ event });
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
// entries from before submission, which are for the owner alone. lastViewedAt is
// when this viewer last marked the history viewed (SPM-41 v2), or null.
const getEventHistory = async (req, res, next) => {
  try {
    const { eventId, access } = req.visibleEvent;
    const [{ history, nextCursor }, lastViewedAt] = await Promise.all([
      activityModel.findEventHistory(eventId, { ...req.pagination, audiences: access.historyAudiences }),
      activityModel.findLastHistoryView(eventId, req.user.user_id),
    ]);
    return res.status(200).json({ history, nextCursor, lastViewedAt });

  } catch (error) {
    return handleError(error, res, next);
  }
};

// POST /api/events/:id/history/viewed — SPM-41 v2: anyone who can see the event's
// history records that they viewed it; requireVisibleEvent has already answered
// "not found" for anyone else.
const markEventHistoryViewed = async (req, res, next) => {
  try {
    const lastViewedAt = await activityModel.markEventHistoryViewed(req.visibleEvent.eventId, req.user.user_id);
    return res.status(200).json({ lastViewedAt });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// Only the owner and the assigned coordinator take part in a thread, so only
// their reads are tracked and counted.
const threadReaderId = (req) =>
  [EVENT_RELATIONSHIP.OWNER, EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR].includes(req.visibleEvent.access.relationship)
    ? req.user.user_id
    : null;

// SPM-41: the owner, same-organisation organisers (read-only) and the assigned
// coordinator all see every thread and message; requireVisibleEvent has already
// answered "not found" for anyone else.
const getEventClarifications = async (req, res, next) => {
  try {
    const clarifications = await eventModel.findEventClarifications(req.visibleEvent.eventId, { readerId: threadReaderId(req) });
    return res.status(200).json({ clarifications });
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

const listLeadAssignments = async (req, res, next) => {
  try {
    const assignments = await eventModel.findLeadAssignments(req.user.user_id);
    return res.status(200).json({ assignments });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const listUnassignedEvents = async (req, res, next) => {
  try {
    const events = await eventModel.findUnassignedSubmittedEvents();
    return res
      .status(200)
      .json({ events: events.map(eventModel.toUnassignedQueueItem) });
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

// PATCH /api/events/:id/coordinator — SPM-174 (assign) or SPM-180 (reassign).
// The route middleware requires a Lead. The expectedCoordinatorId field
// distinguishes reassignment from the first assignment.
const patchCoordinator = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const body = req.body;
    const isLead = req.user.role === USER_ROLES.COORDINATOR_LEAD;
    const isReassign =
      body && typeof body === "object" && !Array.isArray(body)
        ? Object.prototype.hasOwnProperty.call(body, "expectedCoordinatorId")
        : false;

    if (isReassign) {
      if (!isLead) {
        return sendError(res, 403, "FORBIDDEN", "Only a coordinator lead may reassign.");
      }
      if (
        Object.keys(body).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(body, "coordinatorId") ||
        !Number.isSafeInteger(body.coordinatorId) ||
        body.coordinatorId < 1 ||
        !Number.isSafeInteger(body.expectedCoordinatorId) ||
        body.expectedCoordinatorId < 1
      ) {
        return validationFailed(res, {
          coordinatorId: "Send a positive integer coordinatorId.",
          expectedCoordinatorId:
            "Send the coordinatorId currently shown as assigned.",
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
    }

    // SPM-174 assignment: the Lead sends only coordinatorId.
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, "coordinatorId")
    ) {
      return validationFailed(res, {
        coordinatorId: "Send a positive integer coordinatorId.",
      });
    }
    if (!Number.isSafeInteger(body.coordinatorId) || body.coordinatorId < 1) {
      return sendError(
        res,
        400,
        "INVALID_COORDINATOR",
        "Select an active Event Coordinator.",
      );
    }
    const assignedEvent = await eventModel.assignCoordinator({
      eventId,
      coordinatorId: body.coordinatorId,
      leadId: req.user.user_id,
    });
    return res.status(200).json({ event: eventModel.toApi(assignedEvent, undefined, { includeStoredStatus: true }) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

const assignCoordinatorAsLead = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(body, "coordinatorId") ||
      !Number.isSafeInteger(body.coordinatorId) ||
      body.coordinatorId < 1
    ) {
      return validationFailed(res, {
        coordinatorId: "Send a positive integer coordinatorId.",
      });
    }
    const assignedEvent = await eventModel.assignCoordinator({
      eventId,
      coordinatorId: body.coordinatorId,
      leadId: req.user.user_id,
    });
    return res.status(200).json({ event: eventModel.toApi(assignedEvent, undefined, { includeStoredStatus: true }) });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// ---------- SPM-173 lifecycle actions ----------

const toReadinessFailures = (codes) =>
  codes.map((code) => ({ code, message: READINESS_MESSAGES[code] || "This condition is not met yet." }));

// Refusals that say more than { error, code }: the status that does not allow
// the action (AC3), or each readiness condition that is not met (AC9).
const LIFECYCLE_REFUSALS = Object.freeze({
  TRANSITION_NOT_ALLOWED: (res, error) => {
    const currentStatus = error.currentStatus ?? null;
    const [status, generalMessage] = DOMAIN_ERRORS.TRANSITION_NOT_ALLOWED;
    return res.status(status).json({
      error: currentStatus ? `This action is not allowed while the event is in ${currentStatus}.` : generalMessage,
      code: "TRANSITION_NOT_ALLOWED",
      currentStatus,
    });
  },
  READINESS_BLOCKED: (res, error) => {
    const [status, message] = DOMAIN_ERRORS.READINESS_BLOCKED;
    return res.status(status).json({ error: message, code: "READINESS_BLOCKED", failures: toReadinessFailures(error.failures || []) });
  },
});

// The body carries only the version of the event the coordinator loaded, so an
// action taken from an outdated page is refused (409) instead of applied.
const readActionRequest = (req) => {
  const body = req.body ?? {};
  if (!isPlainObject(body)) return { errors: { body: "Send the request as a JSON object." } };
  const errors = toUnsupportedFieldErrors(Object.keys(body).filter((key) => key !== "version"));
  const expectedVersion = readVersion(body, true, errors);
  const idempotencyKey = readRequestIdempotencyKey(req, false, errors);
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
    const isRequestError = error.name === "EventRequestError";
    if (isRequestError && error.code === "EVENT_VERSION_CONFLICT") {
      return sendVersionConflict(req, res, eventId).catch(next);
    }
    const sendRefusal = isRequestError ? LIFECYCLE_REFUSALS[error.code] : undefined;
    if (sendRefusal) return sendRefusal(res, error);
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

/// ---------- SPM-41 clarification threads ----------

const KNOWN_AMENDMENT_FIELDS = new Set(AMENDMENT_FIELDS);
const AMENDMENT_COORDINATOR_CONFLICT =
  "The new dates clash with your coordinator's schedule. Choose different dates or contact your coordinator.";

// The body holds the named fields only, plus the version the user loaded where
// the action checks it. The Idempotency-Key header is required because every
// action may notify someone.
const readClarificationRequest = (req, allowed, { requireVersion = true } = {}) => {
  const body = req.body ?? {};
  if (!isPlainObject(body)) return { body: {}, errors: { body: "Send the request as a JSON object." } };
  const accepted = requireVersion ? [...allowed, "version"] : allowed;
  const errors = toUnsupportedFieldErrors(Object.keys(body).filter((key) => !accepted.includes(key)));
  const expectedVersion = requireVersion ? readVersion(body, true, errors) : null;
  const idempotencyKey = readRequestIdempotencyKey(req, true, errors);
  return { body, errors, expectedVersion, idempotencyKey };
};

// ":round" is the thread's number on its event; anything else names no thread.
const readRound = (req) => parseEventId(req.params.round);

const findThread = async (req, round) => {
  const threads = await eventModel.findEventClarifications(req.visibleEvent.eventId, { readerId: threadReaderId(req) });
  return threads.find((thread) => thread.round === round) ?? null;
};

// The event and the thread just written, as the actor now sees them.
const sendClarificationResult = async (req, res, result, message) => {
  const { eventId } = req.visibleEvent;
  markReplay(res, result);
  const [current, threads] = await Promise.all([
    loadEventForViewer(eventId, req.user),
    eventModel.findEventClarifications(eventId, { readerId: req.user.user_id }),
  ]);
  if (!current) return eventNotFound(res);
  return res.status(200).json({
    message,
    event: eventModel.toEventView(current.event, req.user, current.access),
    clarification: threads.find((thread) => thread.clarificationId === result.clarificationId) ?? null,
  });
};

// The database refuses like the SPM-173 actions: 403 naming the status, 409 with
// the current event for a stale version.
const sendClarificationError = (req, res, next, error, overrides = {}) => {
  if (error.name === "EventRequestError") {
    if (error.code === "EVENT_VERSION_CONFLICT") return sendVersionConflict(req, res, req.visibleEvent.eventId).catch(next);
    if (overrides[error.code]) return overrides[error.code](res);
    if (LIFECYCLE_REFUSALS[error.code]) return LIFECYCLE_REFUSALS[error.code](res, error);
  }
  return handleError(error, res, next);
};

// POST /api/events/:id/clarifications — SPM-41 AC1/AC2: the assigned coordinator
// returns an UNDER_REVIEW event with a question, which opens a thread. Another
// coordinator gets 404 (requireVisibleEvent); then 400 for the request; then the
// database decides under the event lock: 403 in another status, 409 for a stale version.
const requestClarification = async (req, res, next) => {
  try {
    const { body, errors, expectedVersion, idempotencyKey } = readClarificationRequest(req, ["message"]);
    if (!errors.body) Object.assign(errors, validateClarificationText(body.message, { field: "message" }));
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = await eventModel.requestClarification({
      eventId: req.visibleEvent.eventId,
      actorId: req.user.user_id,
      message: body.message.trim(),
      expectedVersion,
      idempotencyKey,
    });
    return await sendClarificationResult(req, res, result, "Clarification requested. The organiser has been notified.");
  } catch (error) {
    return sendClarificationError(req, res, next, error);
  }
};

// POST /api/events/:id/clarifications/:round/messages — SPM-41 v2: the owner or
// the assigned coordinator writes in the open thread. Outside the viewing scope
// is 404 (requireVisibleEvent); same-organisation organisers read the thread but
// cannot write in it (403); then 400 for the message; then 404 for an unknown
// thread or 409 for a completed one. Returns the thread with the new message.
const postClarificationMessage = async (req, res, next) => {
  const { eventId, access } = req.visibleEvent;
  try {
    if (access.relationship === EVENT_RELATIONSHIP.ORGANISATION_MEMBER) return sendDomainError(res, "EVENT_READ_ONLY");
    const round = readRound(req);
    if (!round) return sendDomainError(res, "CLARIFICATION_NOT_FOUND");

    const { body, errors, idempotencyKey } = readClarificationRequest(req, ["body"], { requireVersion: false });
    if (!errors.body) {
      Object.assign(errors, validateClarificationText(body.body, { field: "body", requiredMessage: MESSAGES.clarificationBodyRequired }));
    }
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = await eventModel.postClarificationMessage({
      eventId,
      round,
      actorId: req.user.user_id,
      body: body.body.trim(),
      idempotencyKey,
    });
    markReplay(res, result);
    return res.status(201).json({ message: "Message sent.", clarification: await findThread(req, round) });
  } catch (error) {
    return sendClarificationError(req, res, next, error);
  }
};

// Field errors for the owner's amendments, judged against the saved request:
// the merged result must still be a complete submission. Registration settings,
// the organisation and system fields are refused (403), unknown keys are 400.
const checkAmendments = async (existing, changes) => {
  if (changes === undefined) return { errors: { changes: MESSAGES.amendmentEmpty } };
  if (!isPlainObject(changes)) return { errors: { changes: "Send the changed details as a JSON object." } };

  const denied = {};
  const unknown = [];
  for (const key of Object.keys(changes)) {
    if (KNOWN_AMENDMENT_FIELDS.has(key)) continue;
    if (KNOWN_EVENT_FIELDS.has(key)) denied[key] = "This field cannot be changed during a clarification.";
    else unknown.push(key);
  }
  if (hasErrors(denied)) return { denied };
  if (unknown.length) return { errors: toUnsupportedFieldErrors(unknown) };

  const input = eventModel.pickEventInput(changes);
  if (Object.keys(input).length === 0) return { errors: { changes: MESSAGES.amendmentEmpty } };
  const errors = await validateWith(validateSubmission, mergeWithExisting(existing, input));
  // The 48-hour lead time applies only to a newly chosen start (team decision, 2026-10-24).
  if (input.startDatetime === undefined && errors.startDatetime === MESSAGES.leadTime) delete errors.startDatetime;
  return { input, errors };
};

// POST /api/events/:id/amendments — SPM-41 v2 AC3: while the thread is open the
// owner saves amendments; the event stays AWAITING_CLARIFICATION until the
// coordinator completes the thread. Same-organisation organisers get 403.
const saveClarificationAmendments = async (req, res, next) => {
  const { eventId, event: existing, access } = req.visibleEvent;
  try {
    if (access.relationship !== EVENT_RELATIONSHIP.OWNER) return sendDomainError(res, "EVENT_READ_ONLY");

    const { body, errors, expectedVersion, idempotencyKey } = readClarificationRequest(req, ["changes"]);
    if (hasErrors(errors)) return validationFailed(res, errors);

    const { input, errors: fieldErrors, denied } = await checkAmendments(existing, body.changes);
    if (denied) return sendDomainError(res, "FIELD_NOT_EDITABLE", denied);
    if (hasErrors(fieldErrors)) return validationFailed(res, fieldErrors);

    const result = await eventModel.saveClarificationAmendments({
      eventId,
      actorId: req.user.user_id,
      input,
      expectedVersion,
      idempotencyKey,
    });
    markReplay(res, result);
    const current = await loadEventForViewer(eventId, req.user);
    if (!current) return eventNotFound(res);
    return res.status(200).json({
      message: "Amendments saved. Your coordinator can see what changed.",
      event: eventModel.toEventView(current.event, req.user, current.access),
    });
  } catch (error) {
    return sendClarificationError(req, res, next, error, {
      COORDINATOR_CONFLICT: (response) =>
        sendError(response, DOMAIN_ERRORS.COORDINATOR_CONFLICT[0], "COORDINATOR_CONFLICT", AMENDMENT_COORDINATOR_CONFLICT),
    });
  }
};

// POST /api/events/:id/clarifications/:round/complete — SPM-41 v2: the assigned
// coordinator closes the open thread, and the event returns to UNDER_REVIEW with
// the same coordinator. The version check means they have seen the latest
// amendments (409 otherwise).
const completeClarification = async (req, res, next) => {
  try {
    const round = readRound(req);
    if (!round) return sendDomainError(res, "CLARIFICATION_NOT_FOUND");
    const { errors, expectedVersion, idempotencyKey } = readClarificationRequest(req, []);
    if (hasErrors(errors)) return validationFailed(res, errors);

    const result = await eventModel.completeClarification({
      eventId: req.visibleEvent.eventId,
      round,
      actorId: req.user.user_id,
      expectedVersion,
      idempotencyKey,
    });
    return await sendClarificationResult(req, res, result, "Clarification marked complete. The request is back under review.");
  } catch (error) {
    return sendClarificationError(req, res, next, error);
  }
};

// POST /api/events/:id/clarifications/:round/read — SPM-41 v2: opening a thread
// lets the next message notify this person again. Anyone who can see the event
// may call it; only the owner's and assigned coordinator's reads are stored.
const markClarificationRead = async (req, res, next) => {
  try {
    const round = readRound(req);
    if (!round) return sendDomainError(res, "CLARIFICATION_NOT_FOUND");
    await eventModel.markClarificationRead({ eventId: req.visibleEvent.eventId, round, actorId: req.user.user_id });
    return res.status(204).end();
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
  getUnassignedEvents,
  getCoordinatorAvailability,
  patchCoordinator,
  listAttendeeDiscovery,
  getAttendeeEventDetail,
  getEventRequest,
  getEventHistory,
  getEventClarifications,
  markEventHistoryViewed,
  requestClarification,
  postClarificationMessage,
  saveClarificationAmendments,
  completeClarification,
  markClarificationRead,
  listAssignedEvents,
  listLeadAssignments,
  listUnassignedEvents,
  assignCoordinatorAsLead,
  getEventReadiness,
  submitForSafetyReview,
  confirmEvent,
  startPreparation,
  completeEvent,
};
