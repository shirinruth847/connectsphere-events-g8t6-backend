const { runRegistrationAction } = require("./waitlistModel");

// SPM-147: one database transaction (withdraw_event_registration): event lock,
// refusal once the event has started, WITHDRAWN, activity, the attendee's
// confirmation, the owner's late-withdrawal notice within 24 hours of the
// start, and the freed place offered to the next waitlisted attendee.
const withdrawRegistration = async (attendeeId, eventId, idempotencyKey = null) =>
  runRegistrationAction("withdraw_event_registration", { p_attendee_id: attendeeId, p_event_id: eventId }, {}, idempotencyKey);

module.exports = { withdrawRegistration };
