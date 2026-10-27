// Attendee profile save rules (SPM-270). Pure; no database access.
// Name, email and phone belong to the user record and are not set here.

const MAX_PROFILE_TEXT_LENGTH = 1000;
const MAX_INTEGER = 2147483647;
const TEXT_FIELDS = Object.freeze(["dietaryRestrictions", "accessibilityRequirements"]);
const SAVE_FIELDS = new Set([...TEXT_FIELDS, "version"]);

const MESSAGES = Object.freeze({
  bodyInvalid: "Send the profile as a JSON object.",
  textRequired: "Send this field, as text or null to leave it blank.",
  textInvalid: `Enter text of ${MAX_PROFILE_TEXT_LENGTH} characters or fewer, without control characters such as NUL.`,
  versionInvalid: "Version must be the profile version you loaded, or null for a new profile.",
  unknownField: "This field cannot be set.",
});

// PostgreSQL text cannot store U+0000, so it is refused here as a 400 rather
// than failing in the database as a 500.
const NUL_CHARACTER = "\u0000";

// A blank value clears the field and is stored as null.
const readText = (body, key, fields) => {
  if (!Object.prototype.hasOwnProperty.call(body, key)) {
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

// Returns { profile } or { fields }. A save replaces both attendee fields, so
// both must be sent. version is null (or absent) for the first save, otherwise
// the version the attendee loaded.
const validateProfileSave = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { fields: { body: MESSAGES.bodyInvalid } };
  const fields = {};
  for (const key of Object.keys(body)) {
    if (!SAVE_FIELDS.has(key)) fields[key] = MESSAGES.unknownField;
  }
  const dietaryRestrictions = readText(body, "dietaryRestrictions", fields);
  const accessibilityRequirements = readText(body, "accessibilityRequirements", fields);
  const version = body.version === undefined ? null : body.version;
  if (version !== null && !(Number.isInteger(version) && version >= 1 && version <= MAX_INTEGER)) {
    fields.version = MESSAGES.versionInvalid;
  }
  return Object.keys(fields).length
    ? { fields }
    : { profile: { dietaryRestrictions, accessibilityRequirements, version } };
};

module.exports = { validateProfileSave, MAX_PROFILE_TEXT_LENGTH, MESSAGES };
