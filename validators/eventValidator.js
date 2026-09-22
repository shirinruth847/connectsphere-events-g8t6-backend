// Pure validation functions (no database access) so they are easy to unit test.
// Each function returns an object of { fieldName: errorMessage }. Empty object = valid.
const { MIN_LEAD_TIME_HOURS } = require('../config/eventConstants');

const MESSAGES = Object.freeze({
  titleRequired: 'Event Title is required.', // TC-002
  purposeRequired: 'Event Purpose is required.',
  descriptionRequired: 'Event Description is required.',
  startRequired: 'Event start date and time is required.',
  endRequired: 'Event end date and time is required.',
  invalidDate: 'Please enter a valid date and time.',
  leadTime: 'Event date must be at least 48 hours in advance.', // TC-003
  endBeforeStart: 'End time must be after start time.',
  attendanceRequired: 'Expected Attendance is required for submission', // Draft story negative TC
  attendanceInvalid: 'Expected Attendance must be a positive whole number.',
  layoutRequired: 'Preferred layout is required.',
  layoutInvalid: 'Please choose a valid layout option.',
  registrationFlagInvalid: 'Registration setting must be true or false.',
  registrationCapacityRequired: 'Registration capacity is required when registration is enabled.',
  registrationCapacityInvalid: 'Registration capacity must be a positive whole number.',
});

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

// Form inputs often arrive as strings ("150"), so convert before checking.
const toNumber = (value) => (typeof value === 'string' ? Number(value.trim()) : value);
const isPositiveInt = (value) => Number.isInteger(toNumber(value)) && toNumber(value) > 0;

const parseDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Checks the format of any field that HAS a value. Used by both drafts and submissions,
// so a draft can be incomplete but cannot store nonsense (e.g. attendance = -5).
function checkFormats(input, errors, allowedLayouts) {
  let start = null;
  let end = null;

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
  if (!isBlank(input.expectedAttendance) && !isPositiveInt(input.expectedAttendance)) {
    errors.expectedAttendance = MESSAGES.attendanceInvalid;
  }
  if (
    !isBlank(input.preferredLayoutType) &&
    Array.isArray(allowedLayouts) &&
    !allowedLayouts.includes(input.preferredLayoutType)
  ) {
    errors.preferredLayoutType = MESSAGES.layoutInvalid;
  }
  if (
    input.isRegistrationEnabled !== undefined &&
    input.isRegistrationEnabled !== null &&
    typeof input.isRegistrationEnabled !== 'boolean'
  ) {
    errors.isRegistrationEnabled = MESSAGES.registrationFlagInvalid;
  }
  if (!isBlank(input.registrationCapacity) && !isPositiveInt(input.registrationCapacity)) {
    errors.registrationCapacity = MESSAGES.registrationCapacityInvalid;
  }

  return { start };
}

// Draft story, Scenario 1: only the title is mandatory; other fields are format-checked if present.
function validateDraft(input = {}, { allowedLayouts } = {}) {
  const errors = {};
  if (isBlank(input.title)) errors.title = MESSAGES.titleRequired;
  checkFormats(input, errors, allowedLayouts);
  return errors;
}

// Creation story AC2 + TC-002/TC-003, and Draft story Scenario 4 (submitting a draft).
function validateSubmission(input = {}, { now = new Date(), allowedLayouts } = {}) {
  const errors = {};
  const { start } = checkFormats(input, errors, allowedLayouts);

  const required = [
    ['title', MESSAGES.titleRequired],
    ['purpose', MESSAGES.purposeRequired],
    ['description', MESSAGES.descriptionRequired],
    ['startDatetime', MESSAGES.startRequired],
    ['endDatetime', MESSAGES.endRequired],
    ['expectedAttendance', MESSAGES.attendanceRequired],
    ['preferredLayoutType', MESSAGES.layoutRequired],
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
}

const hasErrors = (errors) => Object.keys(errors).length > 0;

module.exports = { validateDraft, validateSubmission, hasErrors, MESSAGES };