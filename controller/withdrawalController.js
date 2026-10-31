const { withdrawRegistration } = require("../model/withdrawalModel");
const { respondToRegistrationAction } = require("./waitlistController");
const { validateNoFields } = require("../validators/waitlistValidator");

// POST /api/registrations/mine/:eventId/withdraw (SPM-147 AC3–AC6). Refused
// with 409 EVENT_STARTED ("Cannot withdraw registration for past events").
const withdrawMyRegistration = async (req, res) =>
  respondToRegistrationAction(req, res, {
    validate: validateNoFields,
    act: (attendeeId, eventId, _input, idempotencyKey) => withdrawRegistration(attendeeId, eventId, idempotencyKey),
  });

module.exports = { withdrawMyRegistration };
