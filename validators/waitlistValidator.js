// Waitlist, place-offer and withdrawal request bodies (SPM-163, SPM-147).
// Pure; no database access. The attendee, event, queue position, offer state
// and deadline are all decided by the backend.
const { MAX_PROFILE_TEXT_LENGTH, MESSAGES: PROFILE_MESSAGES } = require("./attendeeProfileValidator");

const ANSWER_FIELDS = new Set(["dietaryRestrictions", "accessibilityRequirements"]);
const OFFER_FIELDS = new Set(["offerId"]);
const NO_FIELDS = new Set();

const MESSAGES = Object.freeze({
  bodyInvalid: "Send the request as a JSON object.",
  textRequired: PROFILE_MESSAGES.textRequired,
  textInvalid: PROFILE_MESSAGES.textInvalid,
  unknownField: PROFILE_MESSAGES.unknownField,
  offerIdInvalid: "offerId must be the ID of the place offer you were sent.",
});

// PostgreSQL text cannot store U+0000, so it is refused here as a 400.
const NUL_CHARACTER = "\u0000";

const isObject = (body) => body !== null && typeof body === "object" && !Array.isArray(body);

const unknownFields = (body, allowed) => {
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) fields[key.slice(0, 60)] = MESSAGES.unknownField;
  }
  return fields;
};

// Same rule as the attendee profile: text or null, blank stored as null.
const readAnswer = (body, key, fields) => {
  if (!Object.hasOwn(body, key)) {
    fields[key] = MESSAGES.textRequired;
    return null;
  }
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.includes(NUL_CHARACTER) || value.trim().length > MAX_PROFILE_TEXT_LENGTH) {
    fields[key] = MESSAGES.textInvalid;
    return null;
  }
  return value.trim() || null;
};

// Joining keeps the answers the attendee confirmed on the registration form,
// so both are sent (text, or null to leave blank).
const validateWaitlistJoin = (body) => {
  if (!isObject(body)) return { fields: { body: MESSAGES.bodyInvalid } };
  const fields = unknownFields(body, ANSWER_FIELDS);
  const dietaryRestrictions = readAnswer(body, "dietaryRestrictions", fields);
  const accessibilityRequirements = readAnswer(body, "accessibilityRequirements", fields);
  return Object.keys(fields).length > 0 ? { fields } : { answers: { dietaryRestrictions, accessibilityRequirements } };
};

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
