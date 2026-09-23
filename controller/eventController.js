const eventModel = require('../model/eventModel');
const { logActivity } = require('../model/activityLogModel');
const { createNotification } = require('../model/notificationModel');
const { validateDraft, validateSubmission, hasErrors } = require('../validators/eventValidator');
const { EVENT_STATUS, NOTIFICATION_TYPES } = require('../config/eventConstants');

// ---------- helpers ----------

// AC2: field-level errors so the frontend can show each message under its input.
const validationFailed = (res, errors) =>
  res.status(400).json({ message: 'Please fix the highlighted fields.', errors });

// Logging and notifications run AFTER the event is saved. If one of them fails,
// the submission itself should still succeed, so errors are logged, not thrown.
async function safely(label, task) {
  try {
    await task();
  } catch (err) {
    console.error(`[eventController] ${label} failed:`, err.message);
  }
}

// AC4: notification confirming receipt of the request.
function sendSubmissionReceipt(event, userId) {
  return createNotification({
    eventId: event.event_id,
    title: 'Event request received',
    message: `Your event request "${event.title}" (${eventModel.formatRequestId(
      event.event_id
    )}) has been submitted and is pending approval.`,
    type: NOTIFICATION_TYPES.STATUS_CHANGE,
    recipientIds: [userId],
  });
}

function recordActivity(userId, eventId, action, details) {
  return logActivity({ userId, entityName: 'event', entityId: eventId, action, details });
}

// Loads an event and checks it belongs to the logged-in organiser.
// Sends the error response itself and returns null if not allowed.
async function loadOwnEvent(req, res) {
  const eventId = Number(req.params.id);
  if (!Number.isInteger(eventId)) {
    res.status(400).json({ message: 'Invalid event ID.' });
    return null;
  }
  const event = await eventModel.findEventById(eventId);
  if (!event) {
    res.status(404).json({ message: 'Event request not found.' });
    return null;
  }
  if (event.organiser_id !== req.user.user_id) {
    res.status(403).json({ message: 'You can only access your own event requests.' });
    return null;
  }
  return event;
}

// Existing saved values + newly sent values, used to validate the complete picture.
function mergeWithExisting(existingRow, input) {
  return { ...eventModel.pickEventInput(eventModel.toApi(existingRow)), ...input };
}

const nowIso = () => new Date().toISOString();

// ---------- handlers ----------

// POST /api/events  — Creation story: create and submit in one step (AC1-AC4, TC-001-003)
async function createAndSubmit(req, res, next) {
  try {
    const input = eventModel.pickEventInput(req.body);
    const allowedLayouts = await eventModel.getAllowedLayouts();
    const errors = validateSubmission(input, { allowedLayouts });
    if (hasErrors(errors)) return validationFailed(res, errors);

    const userId = req.user.user_id;
    const event = await eventModel.createEvent({
      ...eventModel.toRow(input),
      organiser_id: userId,
      status: EVENT_STATUS.SUBMITTED,
      updated_at: nowIso(),
    });

    await safely('activity log', () =>
      recordActivity(userId, event.event_id, 'EVENT_SUBMITTED', 'Event request created and submitted.')
    );
    await safely('notification', () => sendSubmissionReceipt(event, userId));

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
    const input = eventModel.pickEventInput(req.body);
    const allowedLayouts = await eventModel.getAllowedLayouts();
    const errors = validateDraft(input, { allowedLayouts });
    if (hasErrors(errors)) return validationFailed(res, errors);

    const userId = req.user.user_id;
    const event = await eventModel.createEvent({
      ...eventModel.toRow(input),
      organiser_id: userId,
      status: EVENT_STATUS.DRAFT,
      updated_at: nowIso(),
    });

    await safely('activity log', () =>
      recordActivity(userId, event.event_id, 'DRAFT_CREATED', 'Event request saved as draft.')
    );

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
    const existing = await loadOwnEvent(req, res);
    if (!existing) return undefined;
    if (existing.status !== EVENT_STATUS.DRAFT) {
      return res.status(409).json({ message: 'Only draft requests can be edited here.' });
    }

    const input = eventModel.pickEventInput(req.body);
    const allowedLayouts = await eventModel.getAllowedLayouts();
    const errors = validateDraft(mergeWithExisting(existing, input), { allowedLayouts });
    if (hasErrors(errors)) return validationFailed(res, errors);

    const event = await eventModel.updateEvent(existing.event_id, {
      ...eventModel.toRow(input),
      updated_at: nowIso(),
    });

    const isAutoSave = req.body.isAutoSave === true;
    // Auto-saves happen every 30s of idle time, so only manual saves are logged.
    if (!isAutoSave) {
      await safely('activity log', () =>
        recordActivity(req.user.user_id, event.event_id, 'DRAFT_UPDATED', 'Draft saved.')
      );
    }

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
    const existing = await loadOwnEvent(req, res);
    if (!existing) return undefined;
    if (existing.status !== EVENT_STATUS.DRAFT) {
      return res.status(409).json({ message: 'Only draft requests can be submitted.' });
    }

    const input = eventModel.pickEventInput(req.body);
    const allowedLayouts = await eventModel.getAllowedLayouts();
    const errors = validateSubmission(mergeWithExisting(existing, input), { allowedLayouts });
    // Nothing is written on failure, so the status stays DRAFT (draft negative TC).
    if (hasErrors(errors)) return validationFailed(res, errors);

    const userId = req.user.user_id;
    const event = await eventModel.updateEvent(existing.event_id, {
      ...eventModel.toRow(input),
      status: EVENT_STATUS.SUBMITTED,
      updated_at: nowIso(),
    });

    await safely('activity log', () =>
      recordActivity(userId, event.event_id, 'EVENT_SUBMITTED', 'Draft submitted for review.')
    );
    await safely('notification', () => sendSubmissionReceipt(event, userId));

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
    const rows = await eventModel.findEventsByOrganiser(req.user.user_id, status);
    return res.status(200).json({ events: rows.map(eventModel.toApi) });
  } catch (err) {
    return next(err);
  }
}

// GET /api/events/:id  — load one request (e.g. to prefill "Edit Draft")
async function getEventById(req, res, next) {
  try {
    const event = await loadOwnEvent(req, res);
    if (!event) return undefined;
    return res.status(200).json({ event: eventModel.toApi(event) });
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