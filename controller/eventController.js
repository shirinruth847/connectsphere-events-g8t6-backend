const eventModel = require("../model/eventModel");
const {
  validateDraft,
  validateSubmission,
  validateRequirements,
  hasErrors,
} = require("../validators/eventValidator");
const { EVENT_STATUS } = require("../config/eventConstants");
const { USER_ROLES } = require("../config/roles");

const EVENT_STATUSES = Object.values(EVENT_STATUS);
const MAX_EVENT_ID = 2147483647;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const IDEMPOTENCY_KEY_MESSAGE =
  "Send an Idempotency-Key header of 8-128 letters, digits, '.', '_', ':' or '-' (a UUID works).";

const DOMAIN_ERRORS = Object.freeze({
  EVENT_NOT_FOUND: [404, "Event request not found."],
  EVENT_NOT_DRAFT: [409, "Only draft requests can be changed or submitted."],
  NO_ELIGIBLE_COORDINATOR: [
    409,
    "No coordinator is currently available. Your request was not submitted.",
  ],
  IDEMPOTENCY_KEY_REUSED: [
    409,
    "This Idempotency-Key was already used for a different request.",
  ],
  IDEMPOTENCY_IN_PROGRESS: [
    409,
    "This request is still being processed. Try again shortly.",
  ],
  COORDINATOR_CONFLICT: [
    409,
    "The selected coordinator is unavailable during this event.",
  ],
  INVALID_COORDINATOR: [400, "Select an active Event Coordinator."],
  COORDINATOR_UNCHANGED: [
    409,
    "The selected coordinator is already assigned to this event.",
  ],
  ASSIGNMENT_CHANGED: [
    409,
    "This event was reassigned by someone else. Refresh and try again.",
  ],
  EVENT_NOT_REASSIGNABLE: [404, "Event request not found."],
});

// ---------- helpers ----------

// Same shape as every other API error: { error, code } plus fields for validation.
const sendError = (res, status, code, error, fields) =>
  res.status(status).json(fields ? { error, code, fields } : { error, code });

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
    if (error.code === "VALIDATION_FAILED")
      return validationFailed(res, error.fields || {});
    if (error.code === "INVALID_CURSOR")
      return validationFailed(res, { cursor: "Invalid page cursor." });
    if (error.code === "IDEMPOTENCY_KEY_REQUIRED")
      return validationFailed(res, { idempotencyKey: IDEMPOTENCY_KEY_MESSAGE });
    const mapped = DOMAIN_ERRORS[error.code];
    if (mapped)
      return sendError(res, mapped[0], error.code, mapped[1], error.fields);
  }
  return next(error);
};

// IDs that cannot exist are "not found", like IDs the user may not see.
const parseEventId = (value) =>
  /^[1-9]\d{0,9}$/.test(value) && Number(value) <= MAX_EVENT_ID
    ? Number(value)
    : null;

const readIdempotencyKey = (req) => {
  const key = req.get("Idempotency-Key");
  return typeof key === "string" && IDEMPOTENCY_KEY.test(key) ? key : null;
};

// Returns field errors for the request shape itself. Object.fromEntries keeps a
// client-sent "__proto__" key as plain data.
const checkRequestBody = (body, { allowAutoSave = false } = {}) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body: "Send the event request as a JSON object." };
  }
  const fields = Object.fromEntries(
    eventModel
      .getUnsupportedInputFields(body, { allowAutoSave })
      .slice(0, 10)
      .map((field) => [field.slice(0, 60), "This field cannot be set."]),
  );
  if (
    allowAutoSave &&
    body.isAutoSave !== undefined &&
    typeof body.isAutoSave !== "boolean"
  ) {
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
// The 30-second idle timer sends { ...fields, isAutoSave: true }.
const updateDraft = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const body = req.body ?? {};
    const requestErrors = checkRequestBody(body, { allowAutoSave: true });
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
    }

    const input = eventModel.pickEventInput(body);
    const errors = await validateWith(
      validateDraft,
      mergeWithExisting(existing, input),
    );
    if (hasErrors(errors)) return validationFailed(res, errors);

    const isAutoSave = body.isAutoSave === true;
    const result = await eventModel.saveDraft({
      organiserId: req.user.user_id,
      eventId,
      input,
      isAutoSave,
    });
    return res.status(200).json({
      message: isAutoSave ? "Draft auto-saved." : "Draft saved successfully.",
      event: eventModel.toApi(result.event),
      savedAt: result.event.updated_at, // frontend formats this as "Last auto-saved at HH:MM:SS AM/PM"
    });
  } catch (error) {
    return handleError(error, res, next);
  }
};

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

// GET /api/events/mine?status=DRAFT — dashboard lists ("My Drafts" / "My Requests")
const listMyEventRequests = async (req, res, next) => {
  try {
    const { status } = req.query;
    if (status !== undefined && !EVENT_STATUSES.includes(status)) {
      return validationFailed(res, { status: "Unknown status filter." });
    }
    const { events, nextCursor } = await eventModel.findOrganiserEventRequests(
      req.user,
      {
        ...req.pagination,
        status: status ?? null,
      },
    );
    return res.status(200).json({ events, nextCursor });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/events/unassigned — coordinator lead assignment queue.
async function getUnassignedEvents(req, res, next) {
  try {
    const events = await eventModel.findUnassignedSubmittedEvents();
    return res.status(200).json({ events: events.map((event) => eventModel.toListItem(event)) });
  } catch (err) {
    return next(err);
  }
}

// GET /api/events/:id — load one request (e.g. to prefill "Edit Draft")
const getEventRequest = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    if (!eventId) return eventNotFound(res);
    const event = await eventModel.findVisibleEvent(eventId, req.user);
    if (!event) return eventNotFound(res);
    return res
      .status(200)
      .json({ event: eventModel.toApi(event, req.user.user_id) });
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
    const assignments = await eventModel.findLeadAssignments();
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
      .json({ events: events.map(eventModel.toListItem) });
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
// The route middleware allows both coordinatorOperations and leadOnly, so the
// handler decides based on the request body and the actor's role.
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

    // SPM-174 assignment: coordinator or lead sends only coordinatorId.
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
        DOMAIN_ERRORS.INVALID_COORDINATOR[0],
        "INVALID_COORDINATOR",
        DOMAIN_ERRORS.INVALID_COORDINATOR[1],
      );
    }
    const assignedEvent = await eventModel.assignCoordinator({
      eventId,
      coordinatorId: body.coordinatorId,
    });
    return res.status(200).json({ event: eventModel.toApi(assignedEvent) });
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
    return res.status(200).json({ event: eventModel.toApi(assignedEvent) });
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
  submitDraft,
  listMyEventRequests,
  getUnassignedEvents,
  getCoordinatorAvailability,
  patchCoordinator,
  getEventRequest,
  listAssignedEvents,
  listLeadAssignments,
  listUnassignedEvents,
  assignCoordinatorAsLead,
};
