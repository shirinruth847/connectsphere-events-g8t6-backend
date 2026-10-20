// Request checks for the Safety Officer routes (SPM-243 AC5, AC7-AC10). They give
// field-level messages early; the database functions recheck every rule under
// the round lock and remain authoritative.

// Master 5.9: one checklist entry per factor.
const SAFETY_FACTORS = Object.freeze([
  "attendanceCapacity",
  "layout",
  "emergencyAccess",
  "accessibility",
  "equipmentPlacement",
  "venueRestrictions",
]);
const FACTOR_RESULTS = Object.freeze(["SATISFACTORY", "NOT_SATISFACTORY", "NOT_APPLICABLE"]);
const DECISION_OUTCOMES = Object.freeze(["APPROVED", "CHANGES_REQUESTED", "REJECTED"]);

const LIMITS = Object.freeze({
  factorComment: 1000,
  organiserComment: 2000,
  internalNotes: 4000,
  handBackNote: 500,
  requestedChange: 500,
  requestedChanges: 20,
  rejectionReason: 1000,
  rejectedBookings: 20,
});

const MESSAGES = Object.freeze({
  body: "Send the request as a JSON object.",
  unknownField: "This field cannot be set.",
  checklistInvalid: "Send the checklist as an object with one entry per factor.",
  factorUnknown: "This is not one of the six safety factors.",
  factorInvalid: "Send a result and an optional comment.",
  factorRequired: "Record a result for this factor.",
  resultInvalid: "Choose SATISFACTORY, NOT_SATISFACTORY or NOT_APPLICABLE.",
  commentRequired: "Explain the result in a comment.",
  commentTooLong: `Keep the comment to ${LIMITS.factorComment} characters.`,
  organiserComment: `Keep the comment for the organiser to ${LIMITS.organiserComment} characters.`,
  internalNotes: `Keep the internal notes to ${LIMITS.internalNotes} characters.`,
  note: `Keep the note to ${LIMITS.handBackNote} characters.`,
  requestedChanges: `List up to ${LIMITS.requestedChanges} changes of at most ${LIMITS.requestedChange} characters each.`,
  requestedChangesRequired: "List at least one change.",
  outcome: "Choose APPROVED, CHANGES_REQUESTED or REJECTED.",
  rejectedBookings: `Name up to ${LIMITS.rejectedBookings} venue bookings, each once, with a reason of at most ${LIMITS.rejectionReason} characters.`,
  rejectedBookingsRequired: "Name at least one venue booking and why it is unsuitable.",
  rejectedBookingsNotActive: "Name only active venue bookings of this event.",
  arrangementVersion: "Send the arrangement version of the review you loaded.",
  factorsNotSatisfactory: "A factor is not satisfactory, so the round cannot be approved.",
});

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isOptionalText = (value) => value === undefined || value === null || typeof value === "string";
const textLength = (value) => (typeof value === "string" ? value.trim().length : 0);

const unknownFieldErrors = (body, allowed) =>
  Object.fromEntries(
    Object.keys(body)
      .filter((key) => !allowed.includes(key))
      .slice(0, 10)
      .map((key) => [key.slice(0, 60), MESSAGES.unknownField])
  );

// Field errors keyed "checklist.<factor>"; "complete" demands every factor with a
// result, and a comment unless the result is SATISFACTORY.
const checklistErrors = (checklist, { complete }) => {
  if (checklist === undefined || checklist === null) {
    return complete ? Object.fromEntries(SAFETY_FACTORS.map((factor) => [`checklist.${factor}`, MESSAGES.factorRequired])) : {};
  }
  if (!isPlainObject(checklist)) return { checklist: MESSAGES.checklistInvalid };

  const errors = {};
  for (const key of Object.keys(checklist)) {
    if (!SAFETY_FACTORS.includes(key)) errors[`checklist.${key.slice(0, 60)}`] = MESSAGES.factorUnknown;
  }
  for (const factor of SAFETY_FACTORS) {
    const entry = checklist[factor];
    const field = `checklist.${factor}`;
    if (entry === undefined || entry === null) {
      if (complete) errors[field] = MESSAGES.factorRequired;
      continue;
    }
    const keysValid = isPlainObject(entry) && Object.keys(entry).every((key) => key === "result" || key === "comment");
    if (!keysValid || !isOptionalText(entry.result) || !isOptionalText(entry.comment)) {
      errors[field] = MESSAGES.factorInvalid;
    } else if (entry.result == null) {
      if (complete) errors[field] = MESSAGES.factorRequired;
    } else if (!FACTOR_RESULTS.includes(entry.result)) {
      errors[field] = MESSAGES.resultInvalid;
    } else if (typeof entry.comment === "string" && entry.comment.length > LIMITS.factorComment) {
      errors[field] = MESSAGES.commentTooLong;
    } else if (complete && entry.result !== "SATISFACTORY" && textLength(entry.comment) === 0) {
      errors[field] = MESSAGES.commentRequired;
    }
  }
  return errors;
};

const requestedChangesValid = (changes) =>
  changes === undefined ||
  changes === null ||
  (Array.isArray(changes) &&
    changes.length <= LIMITS.requestedChanges &&
    changes.every((change) => typeof change === "string" && textLength(change) > 0 && change.trim().length <= LIMITS.requestedChange));

// The fields every review write may carry besides the checklist.
const commentErrors = (body) => {
  const errors = {};
  if (!isOptionalText(body.organiserComment) || textLength(body.organiserComment) > LIMITS.organiserComment) {
    errors.organiserComment = MESSAGES.organiserComment;
  }
  if (!isOptionalText(body.internalNotes) || textLength(body.internalNotes) > LIMITS.internalNotes) {
    errors.internalNotes = MESSAGES.internalNotes;
  }
  if (!requestedChangesValid(body.requestedChanges)) errors.requestedChanges = MESSAGES.requestedChanges;
  return errors;
};

// PUT /api/safety-reviews/:reviewId/progress: any subset, checklist may be partial.
const PROGRESS_FIELDS = Object.freeze(["checklist", "organiserComment", "internalNotes", "requestedChanges"]);
const validateProgress = (body) => {
  if (!isPlainObject(body)) return { body: MESSAGES.body };
  return {
    ...unknownFieldErrors(body, PROGRESS_FIELDS),
    ...checklistErrors(body.checklist, { complete: false }),
    ...commentErrors(body),
  };
};

// POST /api/safety-reviews/:reviewId/hand-back.
const validateHandBack = (body) => {
  if (body === undefined) return {};
  if (!isPlainObject(body)) return { body: MESSAGES.body };
  const errors = unknownFieldErrors(body, ["note"]);
  if (!isOptionalText(body.note) || textLength(body.note) > LIMITS.handBackNote) errors.note = MESSAGES.note;
  return errors;
};

const rejectedBookingsErrors = (bookings) => {
  if (!Array.isArray(bookings) || bookings.length === 0) return { rejectedBookings: MESSAGES.rejectedBookingsRequired };
  const ids = bookings.map((item) => (isPlainObject(item) ? item.bookingId : undefined));
  const valid =
    bookings.length <= LIMITS.rejectedBookings &&
    bookings.every(
      (item) =>
        isPlainObject(item) &&
        Object.keys(item).every((key) => key === "bookingId" || key === "reason") &&
        Number.isSafeInteger(item.bookingId) &&
        item.bookingId > 0 &&
        typeof item.reason === "string" &&
        textLength(item.reason) > 0 &&
        item.reason.trim().length <= LIMITS.rejectionReason
    ) &&
    new Set(ids).size === ids.length;
  return valid ? {} : { rejectedBookings: MESSAGES.rejectedBookings };
};

// POST /api/safety-reviews/:reviewId/decision.
const DECISION_FIELDS = Object.freeze([
  "outcome",
  "checklist",
  "organiserComment",
  "internalNotes",
  "requestedChanges",
  "rejectedBookings",
  "arrangementVersion",
]);
const validateDecision = (body) => {
  if (!isPlainObject(body)) return { body: MESSAGES.body };
  const errors = {
    ...unknownFieldErrors(body, DECISION_FIELDS),
    ...checklistErrors(body.checklist, { complete: true }),
    ...commentErrors(body),
  };
  if (!DECISION_OUTCOMES.includes(body.outcome)) errors.outcome = MESSAGES.outcome;
  if (!Number.isSafeInteger(body.arrangementVersion) || body.arrangementVersion < 1) {
    errors.arrangementVersion = MESSAGES.arrangementVersion;
  }
  if (body.outcome === "CHANGES_REQUESTED" && !errors.requestedChanges && !(Array.isArray(body.requestedChanges) && body.requestedChanges.length > 0)) {
    errors.requestedChanges = MESSAGES.requestedChangesRequired;
  }
  if (body.outcome === "REJECTED") Object.assign(errors, rejectedBookingsErrors(body.rejectedBookings));
  else if (body.rejectedBookings !== undefined && body.rejectedBookings !== null) errors.rejectedBookings = MESSAGES.unknownField;
  if (body.outcome === "APPROVED" && body.requestedChanges !== undefined && body.requestedChanges !== null) {
    errors.requestedChanges = MESSAGES.unknownField;
  }
  return errors;
};

// The database reports "<field>:<reason>" codes in the error detail.
const DATABASE_FAILURES = Object.freeze({
  REQUIRED: MESSAGES.factorRequired,
  RESULT_REQUIRED: MESSAGES.factorRequired,
  INVALID_RESULT: MESSAGES.resultInvalid,
  COMMENT_REQUIRED: MESSAGES.commentRequired,
  COMMENT_TOO_LONG: MESSAGES.commentTooLong,
  UNKNOWN_FACTOR: MESSAGES.factorUnknown,
  NOT_ACTIVE_ON_EVENT: MESSAGES.rejectedBookingsNotActive,
  TOO_LONG: MESSAGES.note,
});

const toFieldErrors = (detail) => {
  const fields = {};
  for (const failure of String(detail || "").split(",").filter(Boolean)) {
    const [field, reason] = failure.split(":");
    const key = SAFETY_FACTORS.includes(field) ? `checklist.${field}` : field;
    if (field === "requestedChanges" && reason === "REQUIRED") fields[key] = MESSAGES.requestedChangesRequired;
    else if (field === "rejectedBookings" && reason === "REQUIRED") fields[key] = MESSAGES.rejectedBookingsRequired;
    else fields[key] = DATABASE_FAILURES[reason] || MESSAGES[field] || MESSAGES.factorInvalid;
  }
  return fields;
};

module.exports = {
  SAFETY_FACTORS,
  FACTOR_RESULTS,
  DECISION_OUTCOMES,
  LIMITS,
  MESSAGES,
  validateProgress,
  validateHandBack,
  validateDecision,
  toFieldErrors,
};
