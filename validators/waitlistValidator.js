// Waitlist, place-offer and withdrawal request bodies (SPM-163, SPM-147).
// Pure; no database access. The attendee, event, queue position, offer state
// and deadline are all decided by the backend.
const { validateRegistration, MESSAGES: REGISTRATION_MESSAGES } = require("./registrationValidator");

const OFFER_FIELDS = new Set(["offerId"]);
const NO_FIELDS = new Set();

const MESSAGES = Object.freeze({
  bodyInvalid: "Send the request as a JSON object.",
  unknownField: REGISTRATION_MESSAGES.unknownField,
  offerIdInvalid: "offerId must be the ID of the place offer you were sent.",
});

const isObject = (body) => body !== null && typeof body === "object" && !Array.isArray(body);

const unknownFields = (body, allowed) => {
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) fields[key.slice(0, 60)] = MESSAGES.unknownField;
  }
  return fields;
};

// Joining asks the same questions as registering (SPM-134): both answers are
// sent, as text or null to leave blank.
const validateWaitlistJoin = validateRegistration;

// Accept and decline name the offer, so a late click never answers a newer one.
const validateOfferResponse = (body) => {
  if (!isObject(body)) return { fields: { body: MESSAGES.bodyInvalid } };
  const fields = unknownFields(body, OFFER_FIELDS);
  if (!(Number.isSafeInteger(body.offerId) && body.offerId >= 1)) fields.offerId = MESSAGES.offerIdInvalid;
  return Object.keys(fields).length > 0 ? { fields } : { offerId: body.offerId };
};

// Leaving the waitlist and withdrawing take no fields; no body is fine too.
const validateNoFields = (body) => {
  if (body === undefined) return {};
  if (!isObject(body)) return { fields: { body: MESSAGES.bodyInvalid } };
  const fields = unknownFields(body, NO_FIELDS);
  return Object.keys(fields).length > 0 ? { fields } : {};
};

module.exports = { validateWaitlistJoin, validateOfferResponse, validateNoFields, MESSAGES };
