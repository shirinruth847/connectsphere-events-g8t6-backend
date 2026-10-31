const { findAttendeeRegistrations, registerForEvent } = require("../model/registrationModel");
const { findRegisteredAttendeeEvent } = require("../model/eventModel");
const { EVENT_NOT_FOUND } = require("../middleware/authorize");
const { parseEventId, readIdempotencyKey, IDEMPOTENCY_KEY_MESSAGE } = require("../middleware/validate");
const { validateRegistration } = require("../validators/registrationValidator");

const FORBIDDEN = { error: "You do not have permission to access this resource.", code: "FORBIDDEN" };

// Business refusals of a registration (SPM-134). NOT_YET_OPEN, CLOSED and
// FULL stay separate: a full event is not a closed one.
const REGISTRATION_CONFLICTS = Object.freeze({
  ALREADY_REGISTERED: "You're already registered for this event.",
  ALREADY_WAITLISTED: "You're already on the waitlist for this event.",
  REGISTRATION_NOT_YET_OPEN: "Registration for this event hasn't opened yet.",
  REGISTRATION_CLOSED: "Registration for this event is closed.",
  REGISTRATION_FULL: "This event is full, so direct registration isn't available.",
  REGISTRATION_UNAVAILABLE: "Registration isn't available for this event yet. Please try again later.",
  IDEMPOTENCY_KEY_REUSED: "This Idempotency-Key was already used for a different request.",
  IDEMPOTENCY_IN_PROGRESS: "This request is still being processed. Try again shortly.",
});

const listMyRegistrations = async (req, res) => {
  try {
    const { limit, offset } = req.pagination;
    const { registrations, nextOffset } = await findAttendeeRegistrations(req.user.user_id, req.pagination);
    res.status(200).json({ registrations, page: { limit, offset, next_offset: nextOffset } });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

// GET /api/registrations/mine/:eventId — the event and the attendee's own place.
// "Not found" for bad IDs and for events they hold no place on alike.
const getMyRegisteredEvent = async (req, res) => {
  try {
    const eventId = parseEventId(req.params.eventId);
    const found = eventId ? await findRegisteredAttendeeEvent(eventId, req.user.user_id) : null;
    if (!found) {
      return res.status(404).json(EVENT_NOT_FOUND);
    }
    return res.status(200).json(found);
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

// POST /api/registrations/mine/:eventId — register the signed-in attendee.
// The attendee comes from the session; the body holds only their answers.
const registerForMyEvent = async (req, res) => {
  try {
    const eventId = parseEventId(req.params.eventId);
    if (!eventId) {
      return res.status(404).json(EVENT_NOT_FOUND);
    }
    const { answers, fields = {} } = validateRegistration(req.body);
    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey && req.get("Idempotency-Key") !== undefined) {
      fields.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
    }
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });
    }

    const { registration, replayed } = await registerForEvent(req.user.user_id, eventId, answers, idempotencyKey);
    if (replayed) res.set("Idempotent-Replayed", "true");
    return res.status(201).json({ registration });
  } catch (error) {
    if (error.name === "RegistrationError") {
      if (error.code === "EVENT_NOT_FOUND") return res.status(404).json(EVENT_NOT_FOUND);
      if (error.code === "NOT_ATTENDEE") return res.status(403).json(FORBIDDEN);
      if (Object.hasOwn(REGISTRATION_CONFLICTS, error.code)) {
        return res.status(409).json({ error: REGISTRATION_CONFLICTS[error.code], code: error.code });
      }
    }
    console.error("Error:", error);
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

module.exports = { listMyRegistrations, getMyRegisteredEvent, registerForMyEvent };
