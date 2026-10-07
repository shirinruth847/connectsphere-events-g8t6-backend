// Pure validation functions (no database access) so they are easy to unit test.
// Each function returns an object of { fieldName: errorMessage }. Empty object = valid.
// Every value accepted here must also be storable, so bad input becomes a 400, never a 500.
const { MIN_LEAD_TIME_HOURS } = require("../config/eventConstants");

const MAX_INTEGER = 2147483647; // PostgreSQL integer columns
const TEXT_LIMITS = Object.freeze({ title: 200, purpose: 2000, description: 5000 });
const MAX_ACCESSIBILITY_TEXT = 1000;
const MAX_ACCESSIBILITY_ITEMS = 20;
const MAX_ACCESSIBILITY_ITEM_LENGTH = 200;
const MAX_REQUIREMENT_ITEMS = 20;

const MESSAGES = Object.freeze({
  titleRequired: "Event Title is required.", // TC-002
  purposeRequired: "Event Purpose is required.",
  descriptionRequired: "Event Description is required.",
  textInvalid: "Please enter text.",
  titleTooLong: `Event Title must be ${TEXT_LIMITS.title} characters or fewer.`,
  purposeTooLong: `Event Purpose must be ${TEXT_LIMITS.purpose} characters or fewer.`,
  descriptionTooLong: `Event Description must be ${TEXT_LIMITS.description} characters or fewer.`,
  startRequired: "Event start date and time is required.",
  endRequired: "Event end date and time is required.",
  invalidDate: "Please enter a valid date and time.",
  leadTime: "Event date must be at least 48 hours in advance.", // TC-003
  endBeforeStart: "End time must be after start time.",
  attendanceRequired: "Expected Attendance is required for submission", // SPM-37 negative TC
  attendanceInvalid: "Expected Attendance must be a positive whole number.",
  layoutRequired: "Preferred layout is required.",
  layoutInvalid: "Please choose a valid layout option.",
  accessibilityInvalid: `Accessibility needs must be up to ${MAX_ACCESSIBILITY_ITEMS} short text entries.`,
  registrationFlagInvalid: "Registration setting must be true or false.",
  registrationCapacityRequired: "Registration capacity is required when registration is enabled.",
  registrationCapacityInvalid: "Registration capacity must be a positive whole number.",
  venuePreferencesInvalid: "Choose valid venue preferences without duplicates.",
  equipmentRequirementsInvalid: "Choose valid equipment and positive quantities without duplicates.",
});

const TOO_LONG_MESSAGES = Object.freeze({
  title: MESSAGES.titleTooLong,
  purpose: MESSAGES.purposeTooLong,
  description: MESSAGES.descriptionTooLong,
});

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

// Form inputs often arrive as strings ("150"); anything else that is not a whole number is NaN.
const toWholeNumber = (value) => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return Number(value);
  return NaN;
};

const isPositiveInteger = (value) => {
  const number = toWholeNumber(value);
  return Number.isInteger(number) && number > 0 && number <= MAX_INTEGER;
};

// ISO 8601 with an explicit offset. Without one, Node and PostgreSQL would read the
// same text in different time zones and validate a different instant than is stored.
const ISO_DATETIME_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const parseDate = (value) => {
  if (typeof value !== "string") return null;
  const match = ISO_DATETIME_WITH_OFFSET.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
};

const isValidAccessibilityNeeds = (value) => {
  if (typeof value === "string") return value.length <= MAX_ACCESSIBILITY_TEXT;
  return (
    Array.isArray(value) &&
    value.length <= MAX_ACCESSIBILITY_ITEMS &&
    value.every(
      (item) => typeof item === "string" && item.trim() !== "" && item.length <= MAX_ACCESSIBILITY_ITEM_LENGTH
    )
  );
};

const checkText = (input, field, errors) => {
  const value = input[field];
  if (value === undefined || value === null) return;
  if (typeof value !== "string") {
    errors[field] = MESSAGES.textInvalid;
  } else if (value.trim().length > TEXT_LIMITS[field]) {
    errors[field] = TOO_LONG_MESSAGES[field];
  }
};

// Checks the format of any field that HAS a value. Used by both drafts and submissions,
// so a draft can be incomplete but cannot store nonsense (e.g. attendance = -5).
const checkFormats = (input, errors, allowedLayouts) => {
  let start = null;
  let end = null;

  for (const field of Object.keys(TEXT_LIMITS)) {
    checkText(input, field, errors);
  }
  if (!isBlank(input.startDatetime)) {
    start = parseDate(input.startDatetime);
    if (!start) errors.startDatetime = MESSAGES.invalidDate;
  }
  if (!isBlank(input.endDatetime)) {
    end = parseDate(input.endDatetime);
    if (!end) errors.endDatetime = MESSAGES.invalidDate;
  }
  if (start && end && end <= start) {
    errors.endDatetime = MESSAGES.endBeforeStart;
  }
  if (!isBlank(input.expectedAttendance) && !isPositiveInteger(input.expectedAttendance)) {
    errors.expectedAttendance = MESSAGES.attendanceInvalid;
  }
  if (
    !isBlank(input.preferredLayoutType) &&
    (typeof input.preferredLayoutType !== "string" ||
      (Array.isArray(allowedLayouts) && !allowedLayouts.includes(input.preferredLayoutType.trim())))
  ) {
    errors.preferredLayoutType = MESSAGES.layoutInvalid;
  }
  if (
    input.accessibilityNeeds !== undefined &&
    input.accessibilityNeeds !== null &&
    !isValidAccessibilityNeeds(input.accessibilityNeeds)
  ) {
    errors.accessibilityNeeds = MESSAGES.accessibilityInvalid;
  }
  if (
    input.isRegistrationEnabled !== undefined &&
    input.isRegistrationEnabled !== null &&
    typeof input.isRegistrationEnabled !== "boolean"
  ) {
    errors.isRegistrationEnabled = MESSAGES.registrationFlagInvalid;
  }
  if (!isBlank(input.registrationCapacity) && !isPositiveInteger(input.registrationCapacity)) {
    errors.registrationCapacity = MESSAGES.registrationCapacityInvalid;
  }

  return { start };
};

// SPM-37 Scenario 1: only the title is mandatory; other fields are format-checked if present.
const validateDraft = (input = {}, { allowedLayouts } = {}) => {
  const errors = {};
  if (isBlank(input.title)) errors.title = MESSAGES.titleRequired;
  checkFormats(input, errors, allowedLayouts);
  return errors;
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasInvalidIds = (ids, allowedIds) =>
  ids.length > MAX_REQUIREMENT_ITEMS ||
  ids.some((id) => !isPositiveInteger(id)) ||
  new Set(ids).size !== ids.length ||
  (Array.isArray(allowedIds) && ids.some((id) => !allowedIds.includes(id)));

const validateRequirements = (input = {}, { venueIds, equipmentIds } = {}) => {
  const errors = {};

  if (input.venuePreferences !== undefined) {
    const preferences = input.venuePreferences;
    if (!Array.isArray(preferences) || hasInvalidIds(preferences.map(toWholeNumber), venueIds)) {
      errors.venuePreferences = MESSAGES.venuePreferencesInvalid;
    }
  }

  if (input.equipmentRequirements !== undefined) {
    const requirements = input.equipmentRequirements;
    const isValidLine = (item) =>
      isPlainObject(item) &&
      Object.keys(item).every((key) => key === "equipmentId" || key === "quantity") &&
      isPositiveInteger(item.quantity);
    if (
      !Array.isArray(requirements) ||
      !requirements.every(isValidLine) ||
      hasInvalidIds(requirements.map((item) => toWholeNumber(item.equipmentId)), equipmentIds)
    ) {
      errors.equipmentRequirements = MESSAGES.equipmentRequirementsInvalid;
    }
  }

  return errors;
};

// SPM-35 AC2 + TC-002/TC-003, and SPM-37 Scenario 4 (submitting a draft).
const validateSubmission = (input = {}, { now = new Date(), allowedLayouts } = {}) => {
  const errors = {};
  const { start } = checkFormats(input, errors, allowedLayouts);

  const required = [
    ["title", MESSAGES.titleRequired],
    ["purpose", MESSAGES.purposeRequired],
    ["description", MESSAGES.descriptionRequired],
    ["startDatetime", MESSAGES.startRequired],
    ["endDatetime", MESSAGES.endRequired],
    ["expectedAttendance", MESSAGES.attendanceRequired],
    ["preferredLayoutType", MESSAGES.layoutRequired],
  ];
  for (const [field, message] of required) {
    if (isBlank(input[field])) errors[field] = message;
  }

  // 48-hour minimum lead time. Exactly 48 hours is allowed.
  if (start && !errors.startDatetime) {
    const earliestAllowed = new Date(now.getTime() + MIN_LEAD_TIME_HOURS * 60 * 60 * 1000);
    if (start < earliestAllowed) errors.startDatetime = MESSAGES.leadTime;
  }

  if (input.isRegistrationEnabled === true && isBlank(input.registrationCapacity)) {
    errors.registrationCapacity = MESSAGES.registrationCapacityRequired;
  }

  return errors;
};

const hasErrors = (errors) => Object.keys(errors).length > 0;

module.exports = {
  validateDraft,
  validateSubmission,
  validateRequirements,
  hasErrors,
  toWholeNumber,
  MESSAGES,
  TEXT_LIMITS,
  MAX_INTEGER,
};
