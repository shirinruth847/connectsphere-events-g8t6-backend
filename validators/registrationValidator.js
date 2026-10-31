// Event registration answers (SPM-134). Pure; no database access.
// The attendee, event, status, capacity, window and confirmation number are all
// decided by the backend; name and email come from the user record.
const { readAttendeeText, MESSAGES: PROFILE_MESSAGES } = require("./attendeeProfileValidator");

const REGISTRATION_FIELDS = new Set(["dietaryRestrictions", "accessibilityRequirements"]);

const MESSAGES = Object.freeze({
  bodyInvalid: "Send the registration as a JSON object.",
  textRequired: PROFILE_MESSAGES.textRequired,
  textInvalid: PROFILE_MESSAGES.textInvalid,
  unknownField: PROFILE_MESSAGES.unknownField,
});

// Returns { answers } or { fields }. Both answers must be sent (text, or null to
// leave blank) so the registration records exactly what the attendee confirmed.
const validateRegistration = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { fields: { body: MESSAGES.bodyInvalid } };
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!REGISTRATION_FIELDS.has(key)) fields[key.slice(0, 60)] = MESSAGES.unknownField;
  }
  const dietaryRestrictions = readAttendeeText(body, "dietaryRestrictions", fields);
  const accessibilityRequirements = readAttendeeText(body, "accessibilityRequirements", fields);
  return Object.keys(fields).length ? { fields } : { answers: { dietaryRestrictions, accessibilityRequirements } };
};

module.exports = { validateRegistration, MESSAGES };
