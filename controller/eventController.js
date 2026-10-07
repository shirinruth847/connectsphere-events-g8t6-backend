const eventModel = require('../model/eventModel');
const {
  validateDraft,
  validateSubmission,
  validateRequirements,
  hasErrors,
} = require('../validators/eventValidator');
const { EVENT_STATUS } = require('../config/eventConstants');

// ---------- helpers ----------

// AC2: field-level errors so the frontend can show each message under its input.
const validationFailed = (res, errors) =>
  res.status(400).json({ message: 'Please fix the highlighted fields.', errors });

function validateRequestBody(req, res, { allowAutoSave = false } = {}) {
  if (req.body === undefined) req.body = {};
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return validationFailed(res, { _request: 'A JSON object is required.' });
  }

  const unsupported = eventModel.getUnsupportedInputFields(req.body, { allowAutoSave });
  if (unsupported.length) {
    const fields = unsupported.slice(0, 5).map((field) => field.slice(0, 60));
    return validationFailed(res, { _request: `Unsupported request field(s): ${fields.join(', ')}.` });
  }
  if (allowAutoSave && req.body.isAutoSave !== undefined && typeof req.body.isAutoSave !== 'boolean') {
    return validationFailed(res, { isAutoSave: 'Auto-save flag must be true or false.' });
  }
  return null;
}

async function getValidationContext() {
  const [allowedLayouts, allowedRequirements] = await Promise.all([
    eventModel.getAllowedLayouts(),
    eventModel.getAllowedRequirementIds(),
  ]);
  return { allowedLayouts, ...allowedRequirements };
}

// Loads an event and checks it belongs to the logged-in organiser.
// Sends the error response itself and returns null if not allowed.
async function loadOwnEvent(req, res) {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ message: 'Invalid event ID.' });
    return null;
  }
  const event = await eventModel.findEventById(eventId, req.user);
  if (!event) {
    res.status(404).json({ message: 'Event request not found.' });
    return null;
  }
  return event;
}

// Existing saved values + newly sent values, used to validate the complete picture.
function mergeWithExisting(existingRow, input) {
  return { ...eventModel.pickEventInput(eventModel.toApi(existingRow)), ...input };
}

// ---------- handlers ----------

// POST /api/events  — Creation story: create and submit in one step (AC1-AC4, TC-001-003)
async function createAndSubmit(req, res, next) {
  try {
    const bodyError = validateRequestBody(req, res);
    if (bodyError) return bodyError;
    const input = eventModel.pickEventInput(req.body);
    const validationContext = await getValidationContext();
    const errors = {
      ...validateSubmission(input, { allowedLayouts: validationContext.allowedLayouts }),
      ...validateRequirements(input, validationContext),
    };
    if (hasErrors(errors)) return validationFailed(res, errors);

    const userId = req.user.user_id;
    const event = await eventModel.submitEvent({ organiserId: userId, input });

    return res.status(201).json({
      message: 'Your event request has been submitted successfully.',
      event: eventModel.toApi(event),
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/events/drafts  — Draft story Scenario 1 (and the first auto-save)
async function createDraft(req, res, next) {
  try {
    const bodyError = validateRequestBody(req, res);
    if (bodyError) return bodyError;
    const input = eventModel.pickEventInput(req.body);
    const validationContext = await getValidationContext();
    const errors = {
      ...validateDraft(input, { allowedLayouts: validationContext.allowedLayouts }),
      ...validateRequirements(input, validationContext),
    };
    if (hasErrors(errors)) return validationFailed(res, errors);

    const event = await eventModel.saveDraft({
      organiserId: req.user.user_id,
      input,
    });

    return res.status(201).json({
      message: 'Draft saved successfully.',
      event: eventModel.toApi(event),
      savedAt: event.updated_at,
    });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/events/:id/draft  — Draft story Scenarios 1 & 3 (manual save and auto-save)
// Send { ...fields, isAutoSave: true } from the 30-second idle timer.
async function updateDraft(req, res, next) {
  try {
    const bodyError = validateRequestBody(req, res, { allowAutoSave: true });
    if (bodyError) return bodyError;
    const existing = await loadOwnEvent(req, res);
    if (!existing) return undefined;
    if (existing.status !== EVENT_STATUS.DRAFT) {
      return res.status(409).json({ message: 'Only draft requests can be edited here.' });
    }

    const input = eventModel.pickEventInput(req.body);
    const validationContext = await getValidationContext();
    const completeInput = mergeWithExisting(existing, input);
    const errors = {
      ...validateDraft(completeInput, { allowedLayouts: validationContext.allowedLayouts }),
      ...validateRequirements(completeInput, validationContext),
    };
    if (hasErrors(errors)) return validationFailed(res, errors);

    const isAutoSave = req.body.isAutoSave === true;
    const event = await eventModel.saveDraft({
      organiserId: req.user.user_id,
      eventId: existing.event_id,
      input,
      isAutoSave,
    });

    return res.status(200).json({
      message: isAutoSave ? 'Draft auto-saved.' : 'Draft saved successfully.',
      event: eventModel.toApi(event),
      savedAt: event.updated_at, // frontend formats this as "Last auto-saved at HH:MM:SS AM/PM"
    });
  } catch (err) {
    return next(err);
  }
}

// PUT /api/events/:id/submit  — Draft story Scenario 4 (submit a saved draft)
async function submitDraft(req, res, next) {
  try {
    const bodyError = validateRequestBody(req, res);
    if (bodyError) return bodyError;
    const existing = await loadOwnEvent(req, res);
    if (!existing) return undefined;
    if (existing.status !== EVENT_STATUS.DRAFT) {
      return res.status(409).json({ message: 'Only draft requests can be submitted.' });
    }

    const input = eventModel.pickEventInput(req.body);
    const validationContext = await getValidationContext();
    const completeInput = mergeWithExisting(existing, input);
    const errors = {
      ...validateSubmission(completeInput, { allowedLayouts: validationContext.allowedLayouts }),
      ...validateRequirements(completeInput, validationContext),
    };
    // Nothing is written on failure, so the status stays DRAFT (draft negative TC).
    if (hasErrors(errors)) return validationFailed(res, errors);

    const event = await eventModel.submitEvent({
      organiserId: req.user.user_id,
      eventId: existing.event_id,
      input,
    });

    return res.status(200).json({
      message: 'Your event request has been submitted successfully.',
      event: eventModel.toApi(event),
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/events/mine?status=DRAFT  — dashboard lists ("My Drafts" / "My Requests")
async function getMyEvents(req, res, next) {
  try {
    const { status } = req.query;
    if (status && !Object.values(EVENT_STATUS).includes(status)) {
      return res.status(400).json({ message: 'Invalid status filter.' });
    }
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    const fields = {};
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      fields.limit = 'Limit must be a whole number from 1 to 50.';
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
      fields.offset = 'Offset must be a whole number from 0 to 10000.';
    }
    if (req.query.cursor && req.query.offset !== undefined) {
      fields.cursor = 'Cursor and offset cannot be used together.';
    }
    if (Object.keys(fields).length) {
      return res.status(400).json({
        error: 'Please correct the highlighted fields.',
        code: 'VALIDATION_FAILED',
        fields,
      });
    }
    const cursor = eventModel.decodeCursor(req.query.cursor);
    if (!cursor) {
      const result = status
        ? await eventModel.findOrganiserEventRequests(req.user, { limit, offset }, status)
        : await eventModel.findOrganiserEventRequests(req.user, { limit, offset });
      return res.status(200).json({
        events: result.events,
        page: { limit, offset, next_offset: result.nextOffset },
        ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
      });
    }

    const rows = await eventModel.findEventsByOrganiser(req.user, status, limit, cursor, offset);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return res.status(200).json({
      events: page.map((event) => eventModel.toApi(event, req.user.user_id)),
      nextCursor: hasMore && page.length ? eventModel.encodeCursor(page[page.length - 1]) : null,
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/events/:id  — load one request (e.g. to prefill "Edit Draft")
async function getEventById(req, res, next) {
  try {
    const event = await loadOwnEvent(req, res);
    if (!event) return undefined;
    return res.status(200).json({ event: eventModel.toApi(event, req.user.user_id) });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createAndSubmit,
  createDraft,
  updateDraft,
  submitDraft,
  getMyEvents,
  getEventById,
};
