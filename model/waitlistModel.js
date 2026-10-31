const supabase = require("../config/supabase");
const { hashRequest } = require("./eventModel");

// Raised by the waitlist, offer and withdrawal functions (SPM-163, SPM-147);
// each becomes a stable API code.
const REGISTRATION_ACTION_ERRORS = new Set([
  "EVENT_NOT_FOUND",
  "NOT_ATTENDEE",
  "ALREADY_REGISTERED",
  "ALREADY_WAITLISTED",
  "REGISTRATION_NOT_YET_OPEN",
  "REGISTRATION_CLOSED",
  "REGISTRATION_UNAVAILABLE",
  "PLACES_AVAILABLE",
  "NOT_WAITLISTED",
  "OFFER_NOT_FOUND",
  "OFFER_EXPIRED",
  "OFFER_NOT_OPEN",
  "REGISTRATION_FULL",
  "NOT_REGISTERED",
  "EVENT_STARTED",
  "EVENT_NOT_ACTIVE",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
]);

const registrationActionError = (code) => Object.assign(new Error(code), { name: "RegistrationActionError", code });

const toRegistrationActionError = (error) =>
  error.code === "P0001" && REGISTRATION_ACTION_ERRORS.has(error.message)
    ? registrationActionError(error.message)
    : new Error(`[Supabase Error] ${error.message}`);

const toRegistrationActionResult = ({ registration, event }) => ({
  registrationId: registration.registration_id,
  status: registration.registration_status,
  outcome: registration.outcome,
  waitlistPosition: registration.waitlist_position,
  registeredAt: registration.registration_datetime,
  withdrawnAt: registration.withdrawal_date,
  ...(Object.hasOwn(registration, "late_withdrawal") ? { lateWithdrawal: registration.late_withdrawal } : {}),
  event: {
    eventId: event.event_id,
    title: event.title,
    startDatetime: event.start_datetime,
    endDatetime: event.end_datetime,
  },
});

// Each action is one database transaction under the event lock: the place
// change, any offer released or made to the next person, activity and
// notifications commit together (Master 5.6, 7.1).
const runRegistrationAction = async (functionName, params, input, idempotencyKey) => {
  const { data, error } = await supabase.rpc(functionName, {
    ...params,
    p_idempotency_key: idempotencyKey,
    p_request_hash: idempotencyKey ? hashRequest(input, {}, [params.p_event_id]) : null,
  });
  if (error) throw toRegistrationActionError(error);
  if (!data || !data.registration || !data.event) throw new Error(`${functionName} returned no registration.`);
  return { registration: toRegistrationActionResult(data), replayed: data.replayed === true };
};

const joinWaitlist = async (attendeeId, eventId, { dietaryRestrictions, accessibilityRequirements }, idempotencyKey = null) =>
  runRegistrationAction(
    "join_event_waitlist",
    {
      p_attendee_id: attendeeId,
      p_event_id: eventId,
      p_dietary_restrictions: dietaryRestrictions,
      p_accessibility_requirements: accessibilityRequirements,
    },
    { dietaryRestrictions, accessibilityRequirements },
    idempotencyKey
  );

const leaveWaitlist = async (attendeeId, eventId, idempotencyKey = null) =>
  runRegistrationAction("leave_event_waitlist", { p_attendee_id: attendeeId, p_event_id: eventId }, {}, idempotencyKey);

const acceptOffer = async (attendeeId, eventId, offerId, idempotencyKey = null) =>
  runRegistrationAction(
    "accept_waitlist_offer",
    { p_attendee_id: attendeeId, p_event_id: eventId, p_offer_id: offerId },
    { offerId },
    idempotencyKey
  );

const declineOffer = async (attendeeId, eventId, offerId, idempotencyKey = null) =>
  runRegistrationAction(
    "decline_waitlist_offer",
    { p_attendee_id: attendeeId, p_event_id: eventId, p_offer_id: offerId },
    { offerId },
    idempotencyKey
  );

// The attendee's own waitlist places with position and any open offer, for
// "My Events" (SPM-163 AC3). An overdue offer is not returned.
const findWaitlistPositions = async (attendeeId) => {
  const { data, error } = await supabase.rpc("list_waitlist_positions", { p_attendee_id: attendeeId });
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return (data || []).map((row) => ({
    registrationId: row.registration_id,
    eventId: row.event_id,
    waitlistPosition: row.waitlist_position,
    offer: row.offer_id ? { offerId: row.offer_id, expiresAt: row.offer_expires_at } : null,
  }));
};

// Called only by jobs/waitlistOfferExpiryJob.js. Returns the number of offers expired.
const expireDueWaitlistOffers = async (limit) => {
  const { data, error } = await supabase.rpc("expire_due_waitlist_offers", { p_limit: limit });
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data;
};

module.exports = {
  joinWaitlist,
  leaveWaitlist,
  acceptOffer,
  declineOffer,
  findWaitlistPositions,
  expireDueWaitlistOffers,
  runRegistrationAction,
  toRegistrationActionResult,
  REGISTRATION_ACTION_ERRORS,
};
