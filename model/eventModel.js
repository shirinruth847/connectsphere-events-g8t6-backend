// All database access for event requests, plus conversion between API field
// names (camelCase) and database column names (snake_case).
const crypto = require("crypto");
const supabase = require("../config/supabase");
const { VENUE_STATUS } = require("../config/venueConstants");
const {
  EVENT_STATUS,
  NO_LAYOUT_PREFERENCE,
  STATUS_LABELS,
  STATUS_NOTES,
  EVENT_RELATIONSHIP,
  HISTORY_AUDIENCE,
  EVENT_FIELD_GROUPS,
  COORDINATOR_EDITABLE_STATUSES,
  LIFECYCLE_ACTIONS,
  SAFETY_ROUND_STATUS,
} = require("../config/eventConstants");
const { MESSAGES, MAX_INTEGER, toWholeNumber, preferenceVenueId } = require("../validators/eventValidator");

// Allowlist: the ONLY fields a client may set. status, organiser_id, coordinator_id etc.
// are set by the server, so a user cannot send { status: "CONFIRMED" } themselves.
const FIELD_MAP = Object.freeze({
  title: "title",
  purpose: "purpose",
  description: "description",
  technicalSupportNeeds: "technical_support_needs",
  startDatetime: "start_datetime",
  endDatetime: "end_datetime",
  expectedAttendance: "expected_attendance",
  preferredLayoutType: "preferred_layout_type",
  accessibilityNeeds: "accessibility_needs",
  isRegistrationEnabled: "is_registration_enabled",
  registrationCapacity: "registration_capacity",
});

const NUMERIC_FIELDS = ["expectedAttendance", "registrationCapacity"];
const REQUIREMENT_FIELDS = ["venuePreferences", "equipmentRequirements"];
const INPUT_FIELDS = new Set([...Object.keys(FIELD_MAP), ...REQUIREMENT_FIELDS]);
const EVENT_SELECT =
  "*,organisation(organisation_id,name),coordinator:user!event_coordinator_id_fkey(name),event_venue_preference(venue_id,preference_order,requested_start,requested_end),event_equipment_requirement(equipment_id,quantity_requested),venue_suggestion:event_venue_suggestion(venue_id,suggested_at,version,venue(name,address,max_capacity),suggester:user(name))";
// List rows leave out purpose, requirements and other people's IDs (TC-AUTH-015).
// The assigned coordinator's view also names the organiser they are working with.
const COORDINATION_SELECT = `${EVENT_SELECT},organiser:user!event_organiser_id_fkey(user_id,name)`;
const ASSIGNED_COORDINATOR_SELECT = `${EVENT_SELECT},organiser:user!event_organiser_id_fkey(user_id,name,email)`;
// A Safety Officer's view: the rounds that put the event in their scope and the
// number of registered attendees, never who they are (SPM-243 AC2).
const SAFETY_OFFICER_SELECT = `${EVENT_SELECT},registration(count),safety_reviews!inner(review_id,status,claimed_by,decided_by)`;

// SPM-243 AC2: a Safety Officer may see a round that is open and unclaimed (the
// shared queue), open and held by them, or decided by them.
const isRoundInOfficerScope = (round, officerId) =>
  (round.status === SAFETY_ROUND_STATUS.OPEN && (round.claimed_by == null || round.claimed_by === officerId)) ||
  (round.decided_by != null && round.decided_by === officerId);

// The round the officer opens from the event page: the open one in their scope,
// otherwise the latest one they decided. The frontend loads it by this ID rather
// than applying the scope rule itself.
const findOfficerReviewId = (rounds, officerId) => {
  const inScope = (Array.isArray(rounds) ? rounds : []).filter((round) => isRoundInOfficerScope(round, officerId));
  const open = inScope.find((round) => round.status === SAFETY_ROUND_STATUS.OPEN);
  if (open) return open.review_id;
  return inScope.reduce((latest, round) => (latest === null || round.review_id > latest ? round.review_id : latest), null);
};

// The same rule as a PostgREST filter on an embedded safety_reviews resource.
const officerScopeFilter = (officerId) => {
  const id = Number(officerId);
  if (!Number.isSafeInteger(id)) throw new Error("Invalid officer ID.");
  const open = `status.eq.${SAFETY_ROUND_STATUS.OPEN}`;
  return `and(${open},claimed_by.is.null),and(${open},claimed_by.eq.${id}),decided_by.eq.${id}`;
};
// A Lead's scope comes from the open assignment row (SPM-72/74).
const SUPERVISION_SELECT = `${COORDINATION_SELECT},event_assignments(assigned_by,ended_at)`;
// Every other state is active (Master 5.2): supervised and occupying a coordinator.
const CLOSED_EVENT_STATUSES = ["DRAFT", "COMPLETED", "REJECTED", "CANCELLED"];
const CLOSED_EVENT_STATUS_FILTER = `(${CLOSED_EVENT_STATUSES.map((status) => `"${status}"`).join(",")})`;
const LIST_SELECT =
  "event_id,title,status,previously_confirmed,start_datetime,end_datetime,expected_attendance,organiser_id,coordinator_id,submitted_at,created_at,updated_at,organisation(organisation_id,name)";
const UNASSIGNED_QUEUE_SELECT =
  "event_id,title,purpose,status,start_datetime,end_datetime,expected_attendance,coordinator_id,submitted_at,created_at,updated_at,organisation(organisation_id,name),event_venue_preference(venue_id,preference_order),event_equipment_requirement(equipment_id,quantity_requested)";

// Calendar events include richer details for coordinators' schedule view.
const CALENDAR_SELECT =
  "event_id,title,status,start_datetime,end_datetime,expected_attendance,purpose,description,accessibility_needs,preferred_layout_type,is_registration_enabled,registration_capacity,coordinator_id,created_at,updated_at,organisation(organisation_id,name),event_venue_preference(venue_id,preference_order),event_equipment_requirement(equipment_id,quantity_requested)";

const MAX_LOOKUP_IDS = 50;

// ---------- input mapping ----------

const getUnsupportedInputFields = (body = {}, { allowAutoSave = false, allowVersion = false } = {}) =>
  Object.keys(body).filter(
    (key) =>
      !INPUT_FIELDS.has(key) && !(allowAutoSave && key === "isAutoSave") && !(allowVersion && key === "version")
  );

const pickEventInput = (body = {}) => {
  const input = {};
  for (const key of INPUT_FIELDS) {
    if (body[key] !== undefined) input[key] = body[key];
  }
  return input;
};

const toRow = (input) => {
  const row = {};
  for (const [key, column] of Object.entries(FIELD_MAP)) {
    if (input[key] === undefined) continue;
    let value = input[key];
    if (typeof value === "string") value = value.trim();
    if (value === "") value = null;
    if (NUMERIC_FIELDS.includes(key) && value !== null) value = Number(value);
    // accessibility_needs is a text column; multi-select values are stored as a JSON string.
    if (key === "accessibilityNeeds" && Array.isArray(value)) value = JSON.stringify(value);
    row[column] = value;
  }
  return row;
};

// A venue choice for part of the event (SPM-76) goes to the RPC as an object;
// one for the whole event stays a bare venue ID.
const toPreferencePayload = (item) => {
  if (item && typeof item === "object" && item.requestedStart && item.requestedEnd) {
    return { venue_id: Number(item.venueId), requested_start: item.requestedStart, requested_end: item.requestedEnd };
  }
  return Number(preferenceVenueId(item));
};

// The RPC accepts JSON numbers only, so numeric strings from form controls are converted here.
const toRequirementPayload = (input) => ({
  venuePreferences: Array.isArray(input.venuePreferences)
    ? input.venuePreferences.map(toPreferencePayload)
    : input.venuePreferences,
  equipmentRequirements: Array.isArray(input.equipmentRequirements)
    ? input.equipmentRequirements.map(({ equipmentId, quantity }) => ({
        equipment_id: Number(equipmentId),
        quantity: Number(quantity),
      }))
    : input.equipmentRequirements,
});

// Identical normalized input gives an identical hash, whatever the JSON key order was.
// Updates add the event and the version they were made against as scope, so a key
// reused for another event or another edit is reported instead of replayed.
const hashRequest = (row, requirements, scope = []) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([row, requirements.venuePreferences ?? null, requirements.equipmentRequirements ?? null, ...scope])
    )
    .digest("hex");

// ---------- output mapping ----------

const formatRequestId = (eventId) => `REQ-${String(eventId).padStart(6, "0")}`;

// What a request is waiting for, when that is worth telling the organiser. A
// submitted request waits in the unassigned queue until a Lead assigns it; a
// request awaiting clarification waits for the organiser.
const toStatusNote = (row) => {
  if (row.status === EVENT_STATUS.SUBMITTED && row.coordinator_id == null) return STATUS_NOTES.WAITING_FOR_COORDINATOR;
  if (row.status === EVENT_STATUS.AWAITING_CLARIFICATION) return STATUS_NOTES.RETURNED_FOR_ACTION;
  // A confirmed event sent back to planning (for example, an accepted change).
  if ([EVENT_STATUS.PLANNING, EVENT_STATUS.SAFETY_REVIEW].includes(row.status) && row.previously_confirmed === true) {
    return STATUS_NOTES.RECONFIRMATION_PENDING;
  }
  return null;
};

const parseAccessibility = (value) => {
  if (typeof value !== "string" || !value.startsWith("[")) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const toOrganisation = (organisation) =>
  organisation ? { organisationId: organisation.organisation_id, name: organisation.name } : null;

// Accepts embedded event_venue_preference rows or plain venue IDs.
const toVenuePreferenceIds = (preferences) =>
  Array.isArray(preferences)
    ? preferences
        .slice()
        .sort((left, right) => (left.preference_order || 0) - (right.preference_order || 0))
        .map((item) => (typeof item === "number" ? item : item.venue_id))
    : [];

const toEquipmentRequirements = (requirements) =>
  Array.isArray(requirements)
    ? requirements.map((item) => ({
        equipmentId: item.equipment_id,
        quantity: item.quantity_requested ?? item.quantity,
      }))
    : [];

const sortPreferences = (list) =>
  list.slice().sort((left, right) => (left.preference_order || 0) - (right.preference_order || 0));

const toIsoOrNull = (value) => (value ? new Date(value).toISOString() : null);

// Each choice's requested time (SPM-76); null times mean the whole event.
const toVenuePreferenceTimes = (list) =>
  Array.isArray(list)
    ? sortPreferences(list).map((item) => ({
        venueId: typeof item === "number" ? item : item.venue_id,
        requestedStart: typeof item === "number" ? null : toIsoOrNull(item.requested_start),
        requestedEnd: typeof item === "number" ? null : toIsoOrNull(item.requested_end),
      }))
    : [];

const toApi = (row, viewerUserId, { includeStoredStatus = false } = {}) => {
  const venuePreferences = row.venue_preferences || row.event_venue_preference;
  const equipmentRequirements = row.equipment_requirements || row.event_equipment_requirement;
  return {
    eventId: row.event_id,
    requestId: formatRequestId(row.event_id),
    ...(includeStoredStatus ? { status: row.status } : {}),
    statusLabel: STATUS_LABELS[row.status] || "Unknown status",
    statusNote: toStatusNote(row),
    title: row.title,
    purpose: row.purpose,
    description: row.description,
    technicalSupportNeeds: row.technical_support_needs ?? null,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    expectedAttendance: row.expected_attendance,
    preferredLayoutType: row.preferred_layout_type,
    accessibilityNeeds: parseAccessibility(row.accessibility_needs),
    venuePreferences: toVenuePreferenceIds(venuePreferences),
    equipmentRequirements: toEquipmentRequirements(equipmentRequirements),
    venuePreferences: Array.isArray(venuePreferences)
      ? sortPreferences(venuePreferences).map((item) => (typeof item === "number" ? item : item.venue_id))
      : [],
    venuePreferenceTimes: toVenuePreferenceTimes(venuePreferences),
    equipmentRequirements: Array.isArray(equipmentRequirements)
      ? equipmentRequirements.map((item) => ({
          equipmentId: item.equipment_id,
          quantity: item.quantity_requested ?? item.quantity,
        }))
      : [],
    isRegistrationEnabled: row.is_registration_enabled,
    registrationCapacity: row.registration_capacity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at ?? null,
    coordinatorName: row.coordinator?.name ?? null,
    // Sent back as "version" when saving, to detect a save over someone else's change.
    ...(row.version === undefined ? {} : { version: row.version }),
    ...(row.organisation === undefined ? {} : { organisation: toOrganisation(row.organisation) }),
    isAssignedToCoordinator: row.coordinator_id != null,
    ...(viewerUserId === undefined ? {} : { isOwner: row.organiser_id === viewerUserId }),
  };
};

// The event as one signed-in user may see it (SPM-33 AC1). "access" comes from
// getEventAccess; permissions tell the interface which controls to offer and are
// enforced again on every save.
// The coordinator's venue suggestion (SPM-72/74). Organiser-safe: it names a
// venue the organiser could see in their own request form.
const toVenueSuggestion = (suggestion) => {
  const row = Array.isArray(suggestion) ? suggestion[0] : suggestion;
  if (!row) return null;
  return {
    venueId: row.venue_id,
    name: row.venue?.name ?? null,
    address: row.venue?.address ?? null,
    maxCapacity: row.venue?.max_capacity ?? null,
    suggestedAt: row.suggested_at,
    suggestedBy: row.suggester?.name ?? null,
    version: row.version,
  };
};

// Staff see the stored status; organisers see only the label (SPM-173 AC6).
const STAFF_RELATIONSHIPS = new Set([EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR, EVENT_RELATIONSHIP.SUPERVISING_LEAD, EVENT_RELATIONSHIP.SAFETY_OFFICER]);
// The assigned coordinator and the supervising Lead see who organised the
// event (SPM-72 AC2); the Safety Officer does not (SPM-243 TC-03).
const COORDINATION_RELATIONSHIPS = new Set([EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR, EVENT_RELATIONSHIP.SUPERVISING_LEAD]);

const toEventView = (row, user, access) => ({
  ...toApi(row, user.user_id, {
    includeStoredStatus: STAFF_RELATIONSHIPS.has(access.relationship),
  }),
  ...(COORDINATION_RELATIONSHIPS.has(access.relationship)
    ? {
        coordinatorId: row.coordinator_id,
        organiser: row.organiser ? {
          userId: row.organiser.user_id,
          name: row.organiser.name,
          ...(access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR
            ? { email: row.organiser.email ?? null } : {}),
        } : null,
        ...(row.arrangement_version === undefined ? {} : { arrangementVersion: row.arrangement_version }),
      }
    : {}),
  ...(access.relationship === EVENT_RELATIONSHIP.SAFETY_OFFICER
    ? {
        registeredCount: Array.isArray(row.registration) && row.registration[0] ? row.registration[0].count : 0,
        arrangementVersion: row.arrangement_version,
        safetyReviewId: findOfficerReviewId(row.safety_reviews, user.user_id),
      }
    : {}),
  ...(row.venue_suggestion === undefined ? {} : { venueSuggestion: toVenueSuggestion(row.venue_suggestion) }),
  viewerRelationship: access.relationship,
  permissions: {
    canEdit: access.canEdit,
    editableFields: access.editableFields,
    canViewDraftHistory: access.historyAudiences.includes(HISTORY_AUDIENCE.OWNER_ONLY),
    canViewStaffHistory: access.historyAudiences.includes(HISTORY_AUDIENCE.STAFF_ONLY),
    canRequestClarification: access.canRequestClarification === true,
    canPostClarificationMessage: access.canPostClarificationMessage === true,
    canSaveAmendments: access.canSaveAmendments === true,
    canCompleteClarification: access.canCompleteClarification === true,
    canSuggestVenue: access.canSuggestVenue === true,
  },
});

const toListItem = (row, viewerUserId, { includeStoredStatus = false } = {}) => ({
  eventId: row.event_id,
  requestId: formatRequestId(row.event_id),
  ...(includeStoredStatus ? { status: row.status } : {}),
  statusLabel: STATUS_LABELS[row.status] || "Unknown status",
  statusNote: toStatusNote(row),
  title: row.title,
  startDatetime: row.start_datetime,
  endDatetime: row.end_datetime,
  expectedAttendance: row.expected_attendance,
  organisation: toOrganisation(row.organisation),
  isAssignedToCoordinator: row.coordinator_id != null,
  isOwner: row.organiser_id === viewerUserId,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  submittedAt: row.submitted_at ?? null,
});

// Leads need the stated purpose and resource needs to decide who should take
// an unassigned request. Keep this richer representation scoped to that queue.
const toUnassignedQueueItem = (row) => ({
  ...toListItem(row, undefined, { includeStoredStatus: true }),
  purpose: row.purpose,
  venuePreferences: toVenuePreferenceIds(row.event_venue_preference),
  equipmentRequirements: toEquipmentRequirements(row.event_equipment_requirement),
});

// event_registration_availability is a computed field: the database function
// register_for_event also applies (SPM-134, Master 5.6), so discovery shows the
// state registration enforces, from the registration start and end times and
// the primary venue's capacity, by database time.
const LIST_ATTENDEE_DISCOVERY_SELECT =
  "event_id,title,description,start_datetime,end_datetime,registration_open_at,registration_close_at,status,event_registration_availability,organisation(organisation_id,name),venue_booking(status,room(venue(venue_id,name,address)))";
const REGISTERED_SEATS_FILTER = ["registration.registration_status", "REGISTERED"];

// Attendees discover only confirmed events (SPM-44, Master 5.3). PREPARATION is
// deliberately absent; registration availability below is a separate rule.
const ATTENDEE_DISCOVERY_STATUS = EVENT_STATUS.CONFIRMED;

// The legacy schema has no primary-venue flag. Publish only an unambiguous
// approved venue; never choose an arbitrary booking or reveal pending ones.
const attendeeVenue = (bookings = []) => {
  const venues = new Map();
  for (const booking of bookings ?? []) {
    const venue = booking.room?.venue;
    if (booking.status === "APPROVED" && venue) venues.set(venue.venue_id, venue);
  }
  return venues.size === 1 ? venues.values().next().value : null;
};

const attendeeLocation = (bookings = []) => {
  const venue = attendeeVenue(bookings);
  return venue ? [venue.name, venue.address].filter(Boolean).join(", ") || null : null;
};

const toAttendeeDiscoveryItem = (row) => {
  const location = attendeeLocation(row.venue_booking);

  return {
    eventId: row.event_id,
    title: row.title,
    description: row.description,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    organisationName: row.organisation ? row.organisation.name : null,
    location,
    registrationAvailability: row.event_registration_availability,
  };
};

const toAttendeeDetail = (row) => {
  const item = toAttendeeDiscoveryItem(row);
  return {
    ...item,
    registrationOpenAt: row.registration_open_at,
    registrationCloseAt: row.registration_close_at,
  };
};

// ---------- errors ----------

// Domain failures carry a stable code; the controller decides the HTTP response.
const eventRequestError = (code, fields) => {
  const error = new Error(code);
  error.name = "EventRequestError";
  error.code = code;
  if (fields) error.fields = fields;
  return error;
};

const DOMAIN_CODES = new Set([
  "INVALID_REJECTION_REASON",
  "FORBIDDEN",
  "EVENT_NOT_FOUND",
  "EVENT_NOT_DRAFT",
  "NO_ELIGIBLE_COORDINATOR",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "COORDINATOR_CONFLICT",
  "INVALID_COORDINATOR",
  "EVENT_VERSION_CONFLICT",
  "EVENT_NOT_EDITABLE_IN_STATUS",
  "FIELD_NOT_EDITABLE",
  "FORBIDDEN",
  "TRANSITION_NOT_ALLOWED",
  "READINESS_BLOCKED",
  "FEASIBILITY_REQUIREMENTS_MISSING",
  "SAFETY_APPROVAL_REQUIRED",
  "EVENT_NOT_ENDED",
  "COORDINATOR_INVARIANT",
  "CLARIFICATION_NOT_OPEN",
  "CLARIFICATION_NOT_FOUND",
  "CLARIFICATION_CLOSED",
]);

// The lifecycle functions report the event's current status (a refused or stale
// action) or the failing readiness codes in the error detail (SPM-173 AC3, AC9).
const withLifecycleDetail = (domainError, details) => {
  const detail = String(details || "");
  if (["TRANSITION_NOT_ALLOWED", "EVENT_VERSION_CONFLICT"].includes(domainError.code) && detail) {
    domainError.currentStatus = detail;
  }
  if (domainError.code === "FEASIBILITY_REQUIREMENTS_MISSING") {
    domainError.missingFields = detail.split(",").filter(Boolean);
  }
  if (domainError.code === "READINESS_BLOCKED") {
    domainError.failures = detail.split(",").filter(Boolean);
  }
  return domainError;
};

// submit_event_request reports "<field>:<reason>" pairs in the error detail.
const SUBMISSION_FAILURES = Object.freeze({
  "title:REQUIRED": MESSAGES.titleRequired,
  "purpose:REQUIRED": MESSAGES.purposeRequired,
  "description:REQUIRED": MESSAGES.descriptionRequired,
  "startDatetime:REQUIRED": MESSAGES.startRequired,
  "startDatetime:LEAD_TIME": MESSAGES.leadTime,
  "endDatetime:REQUIRED": MESSAGES.endRequired,
  "endDatetime:END_BEFORE_START": MESSAGES.endBeforeStart,
  "expectedAttendance:REQUIRED": MESSAGES.attendanceRequired,
  "expectedAttendance:INVALID": MESSAGES.attendanceInvalid,
  "preferredLayoutType:REQUIRED": MESSAGES.layoutRequired,
  "preferredLayoutType:INVALID": MESSAGES.layoutInvalid,
  "registrationCapacity:REQUIRED": MESSAGES.registrationCapacityRequired,
  "registrationCapacity:INVALID": MESSAGES.registrationCapacityInvalid,
});

// update_event_details reports the same "<field>:<reason>" pairs.
const DETAILS_FAILURES = Object.freeze({
  "title:REQUIRED": MESSAGES.titleRequired,
  "title:INVALID": MESSAGES.textInvalid,
  "title:TOO_LONG": MESSAGES.titleTooLong,
  "purpose:REQUIRED": MESSAGES.purposeRequired,
  "purpose:INVALID": MESSAGES.textInvalid,
  "purpose:TOO_LONG": MESSAGES.purposeTooLong,
  "description:REQUIRED": MESSAGES.descriptionRequired,
  "description:INVALID": MESSAGES.textInvalid,
  "description:TOO_LONG": MESSAGES.descriptionTooLong,
});

const toFieldErrors = (details, messages) => {
  const fields = {};
  for (const failure of String(details || "").split(",")) {
    if (messages[failure]) fields[failure.split(":")[0]] = messages[failure];
  }
  return fields;
};

const RPC_FIELD_ERRORS = Object.freeze({
  DRAFT_TITLE_REQUIRED: { title: MESSAGES.titleRequired },
  INVALID_VENUE_PREFERENCES: { venuePreferences: MESSAGES.venuePreferencesInvalid },
  VENUE_PREFERENCE_OUTSIDE_EVENT: { venuePreferences: MESSAGES.venuePreferenceOutsideEvent },
  INVALID_EQUIPMENT_REQUIREMENTS: { equipmentRequirements: MESSAGES.equipmentRequirementsInvalid },
  AMENDMENT_EMPTY: { changes: MESSAGES.amendmentEmpty },
});

// SPM-41 database checks, reported as "field:FAILURE" in the error detail.
const CLARIFICATION_FAILURES = Object.freeze({
  "message:REQUIRED": MESSAGES.clarificationMessageRequired,
  "message:TOO_LONG": MESSAGES.clarificationTooLong,
  "body:REQUIRED": MESSAGES.clarificationBodyRequired,
  "body:TOO_LONG": MESSAGES.clarificationTooLong,
});

// Constraints are the final check (e.g. a stale draft merge); report them against the field.
const CONSTRAINT_FIELD_ERRORS = Object.freeze({
  event_expected_attendance_positive_check: { expectedAttendance: MESSAGES.attendanceInvalid },
  event_registration_capacity_positive_check: { registrationCapacity: MESSAGES.registrationCapacityInvalid },
  event_registration_enabled_capacity_check: { registrationCapacity: MESSAGES.registrationCapacityRequired },
  event_datetime_order_check: { endDatetime: MESSAGES.endBeforeStart },
  event_venue_preference_pkey: { venuePreferences: MESSAGES.venuePreferencesInvalid },
  event_venue_preference_venue_id_fkey: { venuePreferences: MESSAGES.venuePreferencesInvalid },
  event_venue_preference_requested_window_check: { venuePreferences: MESSAGES.venuePreferenceTimeInvalid },
  event_equipment_requirement_pkey: { equipmentRequirements: MESSAGES.equipmentRequirementsInvalid },
  event_equipment_requirement_equipment_id_fkey: { equipmentRequirements: MESSAGES.equipmentRequirementsInvalid },
});

const toEventRequestError = (error, fields) => {
  if (typeof error === "string") return eventRequestError(error, fields);
  const message = error.message || "";
  const code = error.code || "";

  if (DOMAIN_CODES.has(message)) return withLifecycleDetail(eventRequestError(message, error.fields), error.details);
  if (message === "INVALID_EVENT_SUBMISSION") {
    return eventRequestError("VALIDATION_FAILED", toFieldErrors(error.details, SUBMISSION_FAILURES));
  }
  if (message === "INVALID_EVENT_DETAILS") {
    return eventRequestError("VALIDATION_FAILED", toFieldErrors(error.details, DETAILS_FAILURES));
  }
  if (message === "INVALID_CLARIFICATION") {
    return eventRequestError("VALIDATION_FAILED", toFieldErrors(error.details, CLARIFICATION_FAILURES));
  }
  if (RPC_FIELD_ERRORS[message]) return eventRequestError("VALIDATION_FAILED", RPC_FIELD_ERRORS[message]);

  const constraint = /constraint "([^"]+)"/.exec(message);
  if (constraint && CONSTRAINT_FIELD_ERRORS[constraint[1]]) {
    return eventRequestError("VALIDATION_FAILED", CONSTRAINT_FIELD_ERRORS[constraint[1]]);
  }
  if (code === "23502" && /column "title"/.test(message)) {
    return eventRequestError("VALIDATION_FAILED", { title: MESSAGES.titleRequired });
  }
  if (code === "23P01") return eventRequestError("COORDINATOR_CONFLICT");
  // Data exceptions (bad casts, out-of-range values) are client input the validator missed.
  if (code.startsWith("22") || message === "INVALID_EVENT_PATCH") {
    return eventRequestError("VALIDATION_FAILED", {});
  }
  return error;
};

const dbError = (error) => new Error(`[Supabase Error] ${error.message}`);

// ---------- writes ----------

const callEventRpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw toEventRequestError(error);
  if (!data || !data.event) throw new Error(`${name} returned no event.`);
  return {
    event: {
      ...data.event,
      venue_preferences: data.venue_preferences || [],
      equipment_requirements: data.equipment_requirements || [],
    },
    replayed: data.replayed === true,
  };
};

// Creating a draft (eventId null) needs an idempotency key. On an update the key
// and the expected version are optional: a key stops a retried manual save from
// writing a second history entry, and a version blocks a save over a newer one.
const saveDraft = async ({
  organiserId,
  eventId = null,
  input,
  isAutoSave = false,
  idempotencyKey = null,
  expectedVersion = null,
}) => {
  const row = toRow(input);
  const requirements = toRequirementPayload(input);
  const scope = eventId === null ? [] : [eventId, expectedVersion];
  return callEventRpc("save_event_draft", {
    p_organiser_id: organiserId,
    p_event_id: eventId,
    p_event: row,
    p_venue_preferences: requirements.venuePreferences ?? null,
    p_equipment_requirements: requirements.equipmentRequirements ?? null,
    p_is_auto_save: isAutoSave,
    p_idempotency_key: idempotencyKey,
    p_request_hash: idempotencyKey ? hashRequest(row, requirements, scope) : null,
    ...(expectedVersion === null ? {} : { p_expected_version: expectedVersion }),
  });
};

// SPM-33 AC4: the assigned coordinator's direct edit of ordinary fields. The
// database rechecks assignment, status and version under the event row lock,
// so a coordinator reassigned away a moment ago cannot save.
const updateEventDetails = async ({ actorId, eventId, input, expectedVersion, idempotencyKey }) => {
  const changes = {};
  for (const field of EVENT_FIELD_GROUPS.ORDINARY) {
    const value = input[field];
    if (value !== undefined) changes[FIELD_MAP[field]] = typeof value === "string" ? value.trim() : value;
  }
  return callEventRpc("update_event_details", {
    p_actor_id: actorId,
    p_event_id: eventId,
    p_changes: changes,
    p_expected_version: expectedVersion,
    p_editable_statuses: [...COORDINATOR_EDITABLE_STATUSES],
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest(changes, {}, [eventId, expectedVersion]),
  });
};

// Creating and submitting (eventId null) needs an idempotency key; a second submit
// of the same draft already fails with EVENT_NOT_DRAFT.
const submitEvent = async ({ organiserId, eventId = null, input, idempotencyKey = null }) => {
  const row = toRow(input);
  const requirements = toRequirementPayload(input);
  return callEventRpc("submit_event_request", {
    p_organiser_id: organiserId,
    p_event_id: eventId,
    p_event: row,
    p_venue_preferences: requirements.venuePreferences ?? null,
    p_equipment_requirements: requirements.equipmentRequirements ?? null,
    p_idempotency_key: idempotencyKey,
    p_request_hash: idempotencyKey ? hashRequest(row, requirements) : null,
  });
};

// ---------- reads ----------

// An organiser sees their own requests in any state, plus requests from their
// verified organisations once submitted (Master section 4.2: same-organisation
// visibility begins after submission).
const buildOrganiserVisibilityFilter = (user) => {
  const ownRequests = `organiser_id.eq.${Number(user.user_id)}`;
  const organisationIds = Array.isArray(user.organisation_ids)
    ? user.organisation_ids.map(Number).filter(Number.isSafeInteger)
    : [];
  if (organisationIds.length === 0) return ownRequests;
  return `${ownRequests},and(organisation_id.in.(${organisationIds.join(",")}),status.neq.DRAFT)`;
};

// One read for every role (SPM-33 AC1, SPM-180 AC3): returns the row only when it is
// inside the user's viewing scope, so callers answer "not found" for everything else.
// Venue Staff, Technical Support, Leads and attendees have no scope through this view.
// Same scope as list_lead_event_assignments: the Lead made the open assignment,
// or it predates supervision (no assigning Lead, T23), and the event is active.
const isSupervisedBy = (row, leadId) => {
  if (row.coordinator_id == null || CLOSED_EVENT_STATUSES.includes(row.status)) return false;
  const open = (row.event_assignments || []).find((assignment) => assignment.ended_at == null);
  return !open || open.assigned_by == null || open.assigned_by === leadId;
};

const findVisibleEvent = async (eventId, user) => {
  if (user.role === "COORDINATOR_LEAD") {
    const { data, error } = await supabase.from("event").select(SUPERVISION_SELECT).eq("event_id", eventId).maybeSingle();
    if (error) throw dbError(error);
    return data && isSupervisedBy(data, user.user_id) ? { ...data, supervising_lead_id: user.user_id } : null;
  }
  const select = {
    COORDINATOR: ASSIGNED_COORDINATOR_SELECT,
    SAFETY_OFFICER: SAFETY_OFFICER_SELECT,
  }[user.role] || EVENT_SELECT;
  let query = supabase.from("event").select(select).eq("event_id", eventId);
  if (user.role === "COORDINATOR") {
    query = query.eq("coordinator_id", user.user_id).neq("status", "DRAFT");
  } else if (user.role === "ORGANISER") {
    query = query.or(buildOrganiserVisibilityFilter(user));
  } else if (user.role === "SAFETY_OFFICER") {
    // The inner join returns the event only with a round in the officer's scope.
    query = query
      .neq("status", "DRAFT")
      .or(officerScopeFilter(user.user_id), { referencedTable: "safety_reviews" })
      .eq(...REGISTERED_SEATS_FILTER);
  } else {
    return null;
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw dbError(error);
  // Authorization middleware needs the relationship identifiers on the row.
  // Do not reduce this to a public list item before it derives access.
  return data;
};

const findCoordinatorEvents = async (coordinatorId) => {
  const { data, error } = await supabase
    .from("event")
    .select(LIST_SELECT)
    .eq("coordinator_id", coordinatorId)
    .neq("status", "DRAFT")
    .order("start_datetime", { ascending: true });
  if (error) throw dbError(error);
  return data.map((row) => ({
    eventId: row.event_id,
    requestId: formatRequestId(row.event_id),
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    title: row.title,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    expectedAttendance: row.expected_attendance,
    organisation: toOrganisation(row.organisation),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
};

const findUnassignedSubmittedEvents = async () => {
  const { data, error } = await supabase
    .from("event")
    .select(UNASSIGNED_QUEUE_SELECT)
    .eq("status", "SUBMITTED")
    .is("coordinator_id", null)
    .order("submitted_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("event_id", { ascending: true });
  if (error) throw dbError(error);
  return data;
};

const mapCalendarEvent = (row, coordinatorNames) => ({
  eventId: row.event_id,
  requestId: formatRequestId(row.event_id),
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  title: row.title,
  purpose: row.purpose,
  description: row.description,
  accessibilityNeeds: row.accessibility_needs,
  preferredLayoutType: row.preferred_layout_type,
  isRegistrationEnabled: row.is_registration_enabled,
  registrationCapacity: row.registration_capacity,
  startDatetime: row.start_datetime,
  endDatetime: row.end_datetime,
  expectedAttendance: row.expected_attendance,
  organisation: toOrganisation(row.organisation),
  venuePreferences: toVenuePreferenceIds(row.event_venue_preference),
  equipmentRequirements: toEquipmentRequirements(row.event_equipment_requirement),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  coordinatorId: row.coordinator_id,
  coordinatorName: coordinatorNames.get(row.coordinator_id) || "Inactive Coordinator",
});

const findLeadAssignments = async (leadId) => {
  const { data, error } = await supabase.rpc("list_lead_event_assignments", { p_lead_id: leadId });
  if (error) throw toEventRequestError(error);
  if (!Array.isArray(data)) throw new Error("list_lead_event_assignments returned no assignments.");
  return data;
};

const findCoordinatorAvailability = async () => {
  const [{ data: users, error: usersError }, { data: events, error: eventsError }] = await Promise.all([
    supabase
      .from("user")
      .select("user_id,name")
      .eq("role", "COORDINATOR")
      .eq("is_active", true)
      .order("name", { ascending: true }),
    supabase
      .from("event")
      .select(CALENDAR_SELECT)
      .not("coordinator_id", "is", null)
      .not("status", "in", CLOSED_EVENT_STATUS_FILTER)
      .order("start_datetime", { ascending: true }),
  ]);
  if (usersError) throw dbError(usersError);
  if (eventsError) throw dbError(eventsError);

  const coordinatorNames = new Map(users.map(({ user_id, name }) => [user_id, name]));
  return users.map((user) => ({
    coordinatorId: user.user_id,
    name: user.name,
    events: events
      .filter((event) => event.coordinator_id === user.user_id)
      .map((event) => mapCalendarEvent(event, coordinatorNames)),
  }));
};

const assignCoordinator = async ({ eventId, coordinatorId, leadId }) => {
  const { data, error } = await supabase.rpc("assign_event_coordinator", {
    p_event_id: eventId,
    p_coordinator_id: coordinatorId,
    p_lead_id: leadId,
  });
  if (error) {
    const code = error.message;
    if (["FORBIDDEN", "EVENT_NOT_FOUND", "INVALID_COORDINATOR", "COORDINATOR_CONFLICT"].includes(code)) {
      throw eventRequestError(code);
    }
    throw toEventRequestError(error);
  }
  if (!data || !data.event) throw new Error("assign_event_coordinator returned no event.");
  return data.event;
};

const reassignCoordinator = async ({ eventId, coordinatorId, expectedCoordinatorId, leadId, idempotencyKey }) => {
  const { data, error } = await supabase.rpc("reassign_event_coordinator_idempotent", {
    p_event_id: eventId,
    p_coordinator_id: coordinatorId,
    p_expected_coordinator_id: expectedCoordinatorId,
    p_lead_id: leadId,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest({ coordinatorId, expectedCoordinatorId }, {}, [eventId]),
  });
  if (error) {
    const code = error.message;
    const known = new Set([
      "EVENT_NOT_REASSIGNABLE",
      "INVALID_COORDINATOR",
      "COORDINATOR_CONFLICT",
      "COORDINATOR_UNCHANGED",
      "ASSIGNMENT_CHANGED",
    ]);
    if (known.has(code)) throw eventRequestError(code);
    throw toEventRequestError(error);
  }
  if (!data || !data.event || !data.coordinator) {
    throw new Error("reassign_event_coordinator_idempotent returned an incomplete result.");
  }
  return {
    event: {
      eventId: data.event.event_id,
      requestId: formatRequestId(data.event.event_id),
      title: data.event.title,
      status: data.event.status,
      coordinatorId: data.event.coordinator_id,
    },
    coordinator: {
      coordinatorId: data.coordinator.user_id,
      name: data.coordinator.name,
    },
    replayed: data.replayed === true,
  };
};

// SPM-173: one coordinator lifecycle action (LIFECYCLE_ACTIONS). The database
// function locks the event and rechecks role, assignment, version, state and,
// where the action needs it, readiness and safety approval, then writes the
// state, history and notifications in one transaction.
const runLifecycleAction = async ({ action, eventId, actorId, expectedVersion, idempotencyKey = null }) => {
  const { rpc } = LIFECYCLE_ACTIONS[action];
  const { data, error } = await supabase.rpc(rpc, {
    p_event_id: eventId,
    p_actor_id: actorId,
    p_expected_version: expectedVersion,
    p_idempotency_key: idempotencyKey,
    p_request_hash: idempotencyKey ? hashRequest({ action }, {}, [eventId, expectedVersion]) : null,
  });
  if (error) throw toEventRequestError(error);
  if (!data || !data.event) throw new Error(`${rpc} returned no event.`);
  return { event: data.event, replayed: data.replayed === true };
};

// SPM-40: all rejection effects and replay data commit in one RPC.
const rejectSubmittedEvent = async ({ eventId, actorId, expectedVersion, reason, idempotencyKey }) => {
  const { data, error } = await supabase.rpc("reject_submitted_event", {
    p_event_id: eventId, p_actor_id: actorId, p_expected_version: expectedVersion,
    p_reason: reason, p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest({ reason }, {}, [eventId, expectedVersion]),
  });
  if (error) throw toEventRequestError(error);
  if (!data?.event) throw new Error("reject_submitted_event returned no event.");
  return { event: data.event, replayed: data.replayed === true };
};

// SPM-173 AC8: readiness for the assigned coordinator, with each failing condition.
const getEventReadiness = async ({ eventId, actorId }) => {
  const { data, error } = await supabase.rpc("get_event_readiness", { p_event_id: eventId, p_actor_id: actorId });
  if (error) throw toEventRequestError(error);
  if (!data) throw new Error("get_event_readiness returned no result.");
  return {
    ready: data.ready === true,
    failures: Array.isArray(data.failures) ? data.failures : [],
    status: data.status,
    version: data.version,
    arrangementVersion: data.arrangement_version,
  };
};

// SPM-41 clarification functions return what they wrote under "resultKey" (the
// round, the message or the event) and "replayed" for a repeated Idempotency-Key.
const callClarificationRpc = async (name, args, resultKey) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw toEventRequestError(error);
  if (!data || !data[resultKey]) throw new Error(`${name} returned an incomplete result.`);
  return { data, replayed: data.replayed === true };
};

const toRoundResult = ({ data, replayed }) => ({ clarificationId: data.clarification.clarification_id, replayed });

// SPM-41 AC1: the assigned coordinator returns an UNDER_REVIEW event with a
// question, which opens a thread. The database rechecks role, assignment,
// version and state under the event lock (SPM-173 transition table), then writes
// the round, its first message, the status, its history and the owner's
// notification in one transaction.
const requestClarification = async ({ eventId, actorId, message, expectedVersion, idempotencyKey }) =>
  toRoundResult(await callClarificationRpc("request_event_clarification", {
    p_event_id: eventId,
    p_actor_id: actorId,
    p_expected_version: expectedVersion,
    p_message: message,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest({ message }, {}, [eventId, expectedVersion]),
  }, "clarification"));

// SPM-41 v2: the owner or the assigned coordinator adds a message to the open
// thread. Messages are never edited; the other party is notified unless they
// were already notified and have not opened the thread since.
const postClarificationMessage = async ({ eventId, round, actorId, body, idempotencyKey }) => {
  const { data, replayed } = await callClarificationRpc("post_clarification_message", {
    p_event_id: eventId,
    p_round_number: round,
    p_actor_id: actorId,
    p_body: body,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest({ body }, {}, [eventId, round]),
  }, "message");
  return { messageId: data.message.message_id, replayed };
};

// SPM-41 v2: the owner amends submission fields while the thread is open. The
// event stays AWAITING_CLARIFICATION; any failure leaves the event and its
// requirements as they were.
const saveClarificationAmendments = async ({ eventId, actorId, input, expectedVersion, idempotencyKey }) => {
  const row = toRow(input);
  const requirements = toRequirementPayload(input);
  const { replayed } = await callClarificationRpc("save_clarification_amendments", {
    p_event_id: eventId,
    p_actor_id: actorId,
    p_expected_version: expectedVersion,
    p_changes: row,
    p_venue_preferences: requirements.venuePreferences ?? null,
    p_equipment_requirements: requirements.equipmentRequirements ?? null,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest(row, requirements, [eventId, expectedVersion]),
  }, "event");
  return { replayed };
};

// SPM-41 v2: the assigned coordinator completes the open thread, which returns
// the event to UNDER_REVIEW with the same coordinator and notifies the owner.
const completeClarification = async ({ eventId, round, actorId, expectedVersion, idempotencyKey }) =>
  toRoundResult(await callClarificationRpc("complete_event_clarification", {
    p_event_id: eventId,
    p_round_number: round,
    p_actor_id: actorId,
    p_expected_version: expectedVersion,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest({}, {}, [eventId, round, expectedVersion]),
  }, "clarification"));

// Acknowledge a displayed snapshot; false means newer messages exist or the
// actor cannot track reads. The database serializes this against message writes.
const markClarificationRead = async ({ eventId, round, actorId, lastMessageId }) => {
  const { data, error } = await supabase.rpc("mark_clarification_read", {
    p_event_id: eventId,
    p_round_number: round,
    p_actor_id: actorId,
    p_last_message_id: lastMessageId,
  });
  if (error) throw dbError(error);
  return data === true;
};

// SPM-173 AC12: completes up to "limit" ended events; returns how many.
const completeDueEvents = async (limit) => {
  const { data, error } = await supabase.rpc("complete_due_events", { p_limit: limit });
  if (error) throw dbError(error);
  return Number(data) || 0;
};

// Submitting is owner-only, so a colleague's visible request is "not found" here.
const findOwnEvent = async (eventId, organiserId) => {
  const { data, error } = await supabase
    .from("event")
    .select(EVENT_SELECT)
    .eq("event_id", eventId)
    .eq("organiser_id", organiserId)
    .maybeSingle();
  if (error) throw dbError(error);
  return data;
};

// SPM-41 clarification threads. Joins are named by foreign key because the
// tables reference "user" more than once. "reads" is filtered to the reader.
const CLARIFICATION_SELECT =
  "clarification_id,round_number,status,message,requested_at,requested_by,responded_at,responded_by," +
  "requester:user!clarifications_requested_by_fkey(name),responder:user!clarifications_responded_by_fkey(name)," +
  "messages:clarification_messages!clarification_messages_clarification_id_fkey(" +
  "message_id,body,created_at,author_id,author:user!clarification_messages_author_id_fkey(name,role))," +
  "reads:clarification_reads!clarification_reads_clarification_id_fkey(user_id,last_read_at,last_read_message_id)";

const toClarificationMessage = (row) => ({
  messageId: row.message_id,
  body: row.body,
  createdAt: row.created_at,
  author: { userId: row.author_id, name: row.author ? row.author.name : null, role: row.author ? row.author.role : null },
});

// Messages from the other party after the displayed-message cursor; timestamp
// fallback supports older response fixtures. Non-parties have no tracked reads.
const countUnread = (messages, readerId, reads) => {
  if (readerId == null) return null;
  const read = (reads || []).find((entry) => entry.user_id === readerId);
  const readAt = read && read.last_read_at ? Date.parse(read.last_read_at) : null;
  return messages.filter((message) => message.author_id !== readerId && (
    Number.isInteger(read?.last_read_message_id)
      ? message.message_id > read.last_read_message_id
      : readAt === null || Date.parse(message.created_at) > readAt
  )).length;
};

// A completed thread is stored as RESPONDED (SPM-41 v1 schema) and reported as
// COMPLETED; completedBy is the coordinator who closed it, or for rounds closed
// before threads existed, the organiser who resubmitted.
const toClarification = (row, readerId) => {
  const messages = [...(row.messages || [])].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.message_id - b.message_id
  );
  return {
    clarificationId: row.clarification_id,
    round: row.round_number,
    status: row.status === "OPEN" ? "OPEN" : "COMPLETED",
    message: row.message,
    requestedAt: row.requested_at,
    requestedBy: { userId: row.requested_by, name: row.requester ? row.requester.name : null },
    completedAt: row.responded_at ?? null,
    completedBy:
      row.responded_by == null ? null : { userId: row.responded_by, name: row.responder ? row.responder.name : null },
    messages: messages.map(toClarificationMessage),
    unreadCount: countUnread(messages, readerId, row.reads),
  };
};

// Every thread for one event, newest first, each with its messages oldest first.
// Callers check that the reader may see the event; every relationship that can
// see it may read its threads (SPM-41). Pass readerId only for the owner and the
// assigned coordinator, whose reads are tracked.
const findEventClarifications = async (eventId, { readerId = null } = {}) => {
  const { data, error } = await supabase
    .from("clarifications")
    .select(CLARIFICATION_SELECT)
    .eq("event_id", eventId)
    .eq("reads.user_id", readerId ?? 0)
    .order("round_number", { ascending: false });
  if (error) throw dbError(error);
  return data.map((row) => toClarification(row, readerId));
};

// PostgREST timestamptz text, e.g. 2026-10-07T07:14:14.406209+00:00. The cursor keeps the
// exact text: converting through Date would drop microseconds and skip or repeat rows.
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/;

const encodeKeysetCursor = (timestampKey, timestamp, eventId) =>
  Buffer.from(JSON.stringify({ [timestampKey]: timestamp, eventId })).toString("base64url");

const isValidCursorTimestamp = (value) => {
  if (typeof value !== "string" || !CURSOR_TIMESTAMP.test(value)) return false;
  // Date.parse normalizes dates such as February 31; PostgreSQL rejects them.
  // Check the local calendar date without changing the original microseconds.
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 &&
    day <= days[month - 1] && !Number.isNaN(Date.parse(value));
};

const decodeKeysetCursor = (value, timestampKey) => {
  if (value === undefined || value === null) return null;
  let decoded = null;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    decoded = null;
  }
  if (
    !decoded ||
    !isValidCursorTimestamp(decoded[timestampKey]) ||
    !Number.isSafeInteger(decoded.eventId) ||
    decoded.eventId < 1
  ) {
    throw eventRequestError("INVALID_CURSOR");
  }
  return { [timestampKey]: decoded[timestampKey], eventId: decoded.eventId };
};

const encodeCursor = (row) => encodeKeysetCursor("updatedAt", row.updated_at, row.event_id);
const decodeCursor = (value) => decodeKeysetCursor(value, "updatedAt");

const encodeDiscoveryCursor = (row) => encodeKeysetCursor("startDatetime", row.start_datetime, row.event_id);
const decodeDiscoveryCursor = (value) => decodeKeysetCursor(value, "startDatetime");

// Newest edit first (SPM-37). Keyset paging stays stable while auto-save keeps
// moving updated_at; event_id breaks ties between equal timestamps. "statuses"
// is an organiser label already expanded to its statuses (SPM-173 AC6).
const findOrganiserEventRequests = async (user, { limit, cursor = null, status = null, statuses = null }) => {
  const after = decodeCursor(cursor);
  let query = supabase.from("event").select(LIST_SELECT).or(buildOrganiserVisibilityFilter(user));
  if (status) query = query.eq("status", status);
  if (statuses) query = query.in("status", statuses);
  if (after) {
    query = query.or(
      `updated_at.lt."${after.updatedAt}",and(updated_at.eq."${after.updatedAt}",event_id.lt.${after.eventId})`
    );
  }
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .order("event_id", { ascending: false })
    .limit(limit + 1);
  if (error) throw dbError(error);

  const page = data.slice(0, limit);
  return {
    events: page.map((row) => toListItem(row, user.user_id)),
    nextCursor: data.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
};

// The list and the detail share this query, so visibility and availability cannot drift apart.
const attendeeDiscoveryQuery = () =>
  supabase
    .from("event")
    .select(LIST_ATTENDEE_DISCOVERY_SELECT)
    .eq("is_published", true)
    .eq("status", ATTENDEE_DISCOVERY_STATUS)
    .gt("end_datetime", new Date().toISOString());

// Soonest start first; event_id breaks ties between equal start times.
const findPublishedAttendeeEvents = async ({ limit, cursor = null }) => {
  const after = decodeDiscoveryCursor(cursor);
  let query = attendeeDiscoveryQuery();
  if (after) {
    query = query.or(
      `start_datetime.gt."${after.startDatetime}",and(start_datetime.eq."${after.startDatetime}",event_id.gt.${after.eventId})`
    );
  }
  const { data, error } = await query
    .order("start_datetime", { ascending: true })
    .order("event_id", { ascending: true })
    .limit(limit + 1);
  if (error) throw dbError(error);

  const page = data.slice(0, limit);
  return {
    events: page.map((row) => toAttendeeDiscoveryItem(row)),
    nextCursor: data.length > limit ? encodeDiscoveryCursor(page[page.length - 1]) : null,
  };
};

const findPublishedAttendeeEvent = async (eventId) => {
  const { data, error } = await attendeeDiscoveryQuery().eq("event_id", eventId).maybeSingle();
  if (error) throw dbError(error);
  return data ? toAttendeeDetail(data) : null;
};

// ---------- an attendee's own registered event (SPM-155 AC4, AC5) ----------

// The same rule as _notification_visible: an attendee may open an event, in
// any status, while holding one of these. Discovery's own rules are separate.
const ACTIVE_REGISTRATION_STATUSES = ["REGISTERED", "WAITLISTED"];

// Statuses whose current values are the confirmed, attendee-facing ones.
const CONFIRMED_DETAIL_STATUSES = ["CONFIRMED", "PREPARATION", "COMPLETED"];

// Statuses whose current values may be unconfirmed changes, so attendees see
// the last confirmation snapshot instead (Master 5.3, 5.7).
const SNAPSHOT_DETAIL_STATUSES = ["PLANNING", "SAFETY_REVIEW", "CANCELLED"];

// Attendees see a display status, never the lifecycle state.
const toAttendeeStatus = (status) => {
  if (status === "CONFIRMED" || status === "PREPARATION") return "CONFIRMED";
  if (status === "COMPLETED" || status === "CANCELLED") return status;
  return "PENDING_CONFIRMATION";
};

const findActiveRegistration = async (eventId, attendeeId) => {
  const { data, error } = await supabase
    .from("registration")
    .select("registration_status,registration_datetime")
    .eq("event_id", eventId)
    .eq("attendee_id", attendeeId)
    .in("registration_status", ACTIVE_REGISTRATION_STATUSES)
    .order("registration_datetime", { ascending: false })
    .limit(1);
  if (error) throw dbError(error);
  return data[0] || null;
};

// SPM-173's latest event_confirmation_snapshots row: what attendees were told
// at the last confirmation. Read with the service role; never written here.
const findLatestConfirmationSnapshot = async (eventId) => {
  const { data, error } = await supabase
    .from("event_confirmation_snapshots")
    .select("snapshot,confirmed_at")
    .eq("event_id", eventId)
    .order("snapshot_id", { ascending: false })
    .limit(1);
  if (error) throw dbError(error);
  return data[0] || null;
};

// The same rows for a page of events in one read: event ID -> latest snapshot.
const findLatestConfirmationSnapshots = async (eventIds) => {
  const latest = new Map();
  if (!eventIds.length) return latest;
  const { data, error } = await supabase
    .from("event_confirmation_snapshots")
    .select("event_id,snapshot,confirmed_at")
    .in("event_id", eventIds)
    .order("snapshot_id", { ascending: false });
  if (error) throw dbError(error);
  for (const row of data) {
    if (!latest.has(row.event_id)) latest.set(row.event_id, { snapshot: row.snapshot, confirmed_at: row.confirmed_at });
  }
  return latest;
};

const snapshotLocation = (venue) =>
  venue && typeof venue === "object" ? [venue.name, venue.address].filter(Boolean).join(", ") || null : null;

// The discovery detail fields plus a display status, for an event the
// attendee is registered or waitlisted for, in any status. lastConfirmedAt is
// set when the details are the last confirmed ones rather than the current ones.
const toRegisteredAttendeeEvent = (row, latestSnapshot) => {
  const attendeeStatus = toAttendeeStatus(row.status);
  const { registrationAvailability } = toAttendeeDiscoveryItem(row);
  if (row.is_published && CONFIRMED_DETAIL_STATUSES.includes(row.status)) {
    return { ...toAttendeeDetail(row), attendeeStatus, detailsWithheld: false, lastConfirmedAt: null };
  }
  // Only the snapshot's attendee-facing values, named as in the discovery
  // detail: its venue ID, capacity and registration settings are not passed
  // on. A snapshot taken while the event was unpublished is not shown.
  const snapshot = latestSnapshot?.snapshot;
  if (snapshot && snapshot.is_published === true) {
    return {
      eventId: row.event_id,
      title: snapshot.title ?? row.title,
      description: snapshot.description ?? null,
      startDatetime: snapshot.start_datetime ?? null,
      endDatetime: snapshot.end_datetime ?? null,
      organisationName: row.organisation?.name ?? null,
      location: snapshotLocation(snapshot.primary_venue),
      registrationAvailability,
      registrationOpenAt: snapshot.registration_open_at ?? null,
      registrationCloseAt: snapshot.registration_close_at ?? null,
      attendeeStatus,
      detailsWithheld: false,
      lastConfirmedAt: latestSnapshot.confirmed_at,
    };
  }
  // Never confirmed, unpublished, or in another status: the current values may
  // be unconfirmed, so only the title and status are returned.
  return {
    eventId: row.event_id,
    title: row.title,
    description: null,
    startDatetime: null,
    endDatetime: null,
    organisationName: null,
    location: null,
    registrationAvailability,
    registrationOpenAt: null,
    registrationCloseAt: null,
    attendeeStatus,
    detailsWithheld: true,
    lastConfirmedAt: null,
  };
};

// GET /api/registrations/mine/:eventId: the event and the attendee's own place.
// Null (404) unless they hold a REGISTERED or WAITLISTED place, without saying
// whether the event exists.
const findRegisteredAttendeeEvent = async (eventId, attendeeId) => {
  const registration = await findActiveRegistration(eventId, attendeeId);
  if (!registration) return null;
  const { data, error } = await supabase
    .from("event")
    .select(`${LIST_ATTENDEE_DISCOVERY_SELECT},is_published`)
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw dbError(error);
  if (!data) return null;
  const latestSnapshot = SNAPSHOT_DETAIL_STATUSES.includes(data.status) ? await findLatestConfirmationSnapshot(eventId) : null;
  return {
    event: toRegisteredAttendeeEvent(data, latestSnapshot),
    myRegistration: { status: registration.registration_status, registeredAt: registration.registration_datetime },
  };
};

const toLookupIds = (values) =>
  Array.isArray(values)
    ? [...new Set(values.map(toWholeNumber))]
        .filter((id) => Number.isInteger(id) && id > 0 && id <= MAX_INTEGER)
        .slice(0, MAX_LOOKUP_IDS)
    : [];

const NO_ROWS = { data: [], error: null };

// Looks up only the layout, venues and equipment this request mentions, so an
// auto-save does not read whole catalogue tables. Equipment must be selectable
// (active, detail applied: SPM-52 AC4) unless the event already has it, because
// every save resends all requirements and existing requests are kept (AC9).
const findValidationContext = async (input, keptEquipmentIds = []) => {
  const layout = typeof input.preferredLayoutType === "string" ? input.preferredLayoutType.trim() : "";
  const venueIds = toLookupIds(Array.isArray(input.venuePreferences) ? input.venuePreferences.map(preferenceVenueId) : []);
  const equipmentIds = toLookupIds(
    Array.isArray(input.equipmentRequirements)
      ? input.equipmentRequirements.map((item) => (item && typeof item === "object" ? item.equipmentId : null))
      : []
  );

  const [layouts, venues, equipment] = await Promise.all([
    layout && layout !== NO_LAYOUT_PREFERENCE
      ? supabase.from("room").select("layout_type").eq("layout_type", layout).limit(1)
      : NO_ROWS,
    // Only available venues can be chosen (SPM-73: inactive or unavailable
    // venues cannot be selected for new bookings).
    venueIds.length
      ? supabase.from("venue").select("venue_id").in("venue_id", venueIds).eq("is_active", true).eq("status", VENUE_STATUS.ACTIVE)
      : NO_ROWS,
    equipmentIds.length
      ? supabase.from("equipment").select("equipment_id,is_active,details_pending").in("equipment_id", equipmentIds)
      : NO_ROWS,
  ]);
  for (const result of [layouts, venues, equipment]) {
    if (result.error) throw dbError(result.error);
  }

  return {
    allowedLayouts: [NO_LAYOUT_PREFERENCE, ...layouts.data.map((room) => room.layout_type)],
    venueIds: venues.data.map(({ venue_id }) => venue_id),
    equipmentIds: equipment.data
      .filter((item) => (item.is_active && !item.details_pending) || keptEquipmentIds.includes(item.equipment_id))
      .map(({ equipment_id }) => equipment_id),
  };
};

// Organiser forms need catalogue names/IDs and supported layouts. This read
// does not reserve resources or expose stock counts/internal planning data.
const findRequestOptions = async () => {
  const [venues, rooms, equipment] = await Promise.all([
    supabase
      .from("venue")
      .select("venue_id,name")
      .eq("is_active", true)
      .eq("status", VENUE_STATUS.ACTIVE)
      .order("name", { ascending: true }),
    supabase.from("room").select("layout_type"),
    supabase.from("equipment").select("equipment_id,name").order("name", { ascending: true }),
  ]);
  for (const result of [venues, rooms, equipment]) if (result.error) throw dbError(result.error);
  return {
    venues: venues.data.map(row => ({ venueId: row.venue_id, name: row.name })),
    layouts: [...new Set([NO_LAYOUT_PREFERENCE, ...rooms.data.map(row => row.layout_type)])].filter(Boolean),
    equipment: equipment.data.map(row => ({ equipmentId: row.equipment_id, name: row.name })),
  };
};

module.exports = {
  findRequestOptions,
  getUnsupportedInputFields,
  pickEventInput,
  toRow,
  toApi,
  toEventView,
  toListItem,
  toUnassignedQueueItem,
  formatRequestId,
  toStatusNote,
  parseAccessibility,
  eventRequestError,
  hashRequest,
  toRequirementPayload,
  toEventRequestError,
  saveDraft,
  submitEvent,
  updateEventDetails,
  buildOrganiserVisibilityFilter,
  findVisibleEvent,
  isRoundInOfficerScope,
  officerScopeFilter,
  findCoordinatorEvents,
  findUnassignedSubmittedEvents,
  findCoordinatorAvailability,
  findLeadAssignments,
  assignCoordinator,
  reassignCoordinator,
  runLifecycleAction,
  rejectSubmittedEvent,
  getEventReadiness,
  requestClarification,
  postClarificationMessage,
  saveClarificationAmendments,
  completeClarification,
  markClarificationRead,
  completeDueEvents,
  findOwnEvent,
  findEventClarifications,
  toClarification,
  findOrganiserEventRequests,
  findPublishedAttendeeEvents,
  findPublishedAttendeeEvent,
  findRegisteredAttendeeEvent,
  findLatestConfirmationSnapshots,
  attendeeVenue,
  CONFIRMED_DETAIL_STATUSES,
  SNAPSHOT_DETAIL_STATUSES,
  encodeCursor,
  decodeCursor,
  encodeDiscoveryCursor,
  decodeDiscoveryCursor,
  isValidCursorTimestamp,
  findValidationContext,
};
