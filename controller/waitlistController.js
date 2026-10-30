const { joinWaitlist, leaveWaitlist, acceptOffer, declineOffer } = require("../model/waitlistModel");
const { EVENT_NOT_FOUND } = require("../middleware/authorize");
const { parseEventId, readIdempotencyKey, IDEMPOTENCY_KEY_MESSAGE } = require("../middleware/validate");
const { validateWaitlistJoin, validateOfferResponse, validateNoFields } = require("../validators/waitlistValidator");

const FORBIDDEN = { error: "You do not have permission to access this resource.", code: "FORBIDDEN" };
const OFFER_NOT_FOUND = { error: "Place offer not found.", code: "OFFER_NOT_FOUND" };

// Business refusals of waitlist, offer and withdrawal actions (409).
const REGISTRATION_ACTION_CONFLICTS = Object.freeze({
  ALREADY_REGISTERED: "You're already registered for this event.",
  ALREADY_WAITLISTED: "You're already on the waitlist for this event.",
  REGISTRATION_CLOSED: "Registration for this event is closed.",
  PLACES_AVAILABLE: "This event has places available, so register directly instead.",
  NOT_WAITLISTED: "You're not on the waitlist for this event.",
  OFFER_EXPIRED: "This place offer has expired.",
  OFFER_NOT_OPEN: "This place offer has already been answered.",
  REGISTRATION_FULL: "This event is full, so the offered place is no longer available.",
  NOT_REGISTERED: "You're not registered for this event.",
  EVENT_STARTED: "Cannot withdraw registration for past events",
  EVENT_NOT_ACTIVE: "This event is no longer going ahead.",
  IDEMPOTENCY_KEY_REUSED: "This Idempotency-Key was already used for a different request.",
  IDEMPOTENCY_IN_PROGRESS: "This request is still being processed. Try again shortly.",
});

// One attendee action on their own place. The attendee always comes from the
// session; the body holds only the action's own fields.
const respondToRegistrationAction = async (req, res, { validate, act, successStatus = 200 }) => {
  try {
    const eventId = parseEventId(req.params.eventId);
    if (!eventId) {
      return res.status(404).json(EVENT_NOT_FOUND);
    }
    const { fields = {}, ...input } = validate(req.body);
    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey && req.get("Idempotency-Key") !== undefined) {
      fields.idempotencyKey = IDEMPOTENCY_KEY_MESSAGE;
    }
    if (Object.keys(fields).length > 0) {
      return res.status(400).json({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });
    }

    const { registration, replayed } = await act(req.user.user_id, eventId, input, idempotencyKey);
    if (replayed) res.set("Idempotent-Replayed", "true");
    return res.status(successStatus).json({ registration });
  } catch (error) {
    if (error.name === "RegistrationActionError") {
      if (error.code === "EVENT_NOT_FOUND") return res.status(404).json(EVENT_NOT_FOUND);
      if (error.code === "OFFER_NOT_FOUND") return res.status(404).json(OFFER_NOT_FOUND);
      if (error.code === "NOT_ATTENDEE") return res.status(403).json(FORBIDDEN);
      if (Object.hasOwn(REGISTRATION_ACTION_CONFLICTS, error.code)) {
        return res.status(409).json({ error: REGISTRATION_ACTION_CONFLICTS[error.code], code: error.code });
      }
    }
    console.error("Error:", error);
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

// POST /api/registrations/mine/:eventId/waitlist — join a full event's waitlist (SPM-163 AC1, AC2).
const joinMyWaitlist = async (req, res) =>
  respondToRegistrationAction(req, res, {
    validate: validateWaitlistJoin,
    act: (attendeeId, eventId, { answers }, idempotencyKey) => joinWaitlist(attendeeId, eventId, answers, idempotencyKey),
    successStatus: 201,
  });

// POST /api/registrations/mine/:eventId/waitlist/leave — an open offer counts as declined (SPM-163 AC4).
const leaveMyWaitlist = async (req, res) =>
  respondToRegistrationAction(req, res, {
    validate: validateNoFields,
    act: (attendeeId, eventId, _input, idempotencyKey) => leaveWaitlist(attendeeId, eventId, idempotencyKey),
  });

// POST /api/registrations/mine/:eventId/offer/accept (SPM-163 AC6).
const acceptMyOffer = async (req, res) =>
  respondToRegistrationAction(req, res, {
    validate: validateOfferResponse,
    act: (attendeeId, eventId, { offerId }, idempotencyKey) => acceptOffer(attendeeId, eventId, offerId, idempotencyKey),
  });

// POST /api/registrations/mine/:eventId/offer/decline (SPM-163 AC7).
const declineMyOffer = async (req, res) =>
  respondToRegistrationAction(req, res, {
    validate: validateOfferResponse,
    act: (attendeeId, eventId, { offerId }, idempotencyKey) => declineOffer(attendeeId, eventId, offerId, idempotencyKey),
  });

module.exports = {
  joinMyWaitlist,
  leaveMyWaitlist,
  acceptMyOffer,
  declineMyOffer,
  respondToRegistrationAction,
  REGISTRATION_ACTION_CONFLICTS,
};
