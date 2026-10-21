// All database access for event requests, plus conversion between API field
// names (camelCase) and database column names (snake_case).
const crypto = require("crypto");
const supabase = require("../config/supabase");
const {
  EVENT_STATUS,
  NO_LAYOUT_PREFERENCE,
  STATUS_LABELS,
  STATUS_NOTES,
  EVENT_RELATIONSHIP,
  HISTORY_AUDIENCE,
  EVENT_FIELD_GROUPS,
  COORDINATOR_EDITABLE_STATUSES,
} = require("../config/eventConstants");
const { MESSAGES, MAX_INTEGER, toWholeNumber } = require("../validators/eventValidator");

// Allowlist: the ONLY fields a client may set. status, organiser_id, coordinator_id etc.
// are set by the server, so a user cannot send { status: "CONFIRMED" } themselves.
const FIELD_MAP = Object.freeze({
  title: "title",
  purpose: "purpose",
  description: "description",
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
  "*,organisation(organisation_id,name),coordinator:user!event_coordinator_id_fkey(name),event_venue_preference(venue_id,preference_order),event_equipment_requirement(equipment_id,quantity_requested)";
// List rows leave out purpose, requirements and other people's IDs (TC-AUTH-015).
// The assigned coordinator's view also names the organiser they are working with.
const COORDINATION_SELECT = `${EVENT_SELECT},organiser:user!event_organiser_id_fkey(user_id,name,email)`;
const LIST_SELECT =
  "event_id,title,status,start_datetime,end_datetime,expected_attendance,organiser_id,coordinator_id,submitted_at,created_at,updated_at,organisation(organisation_id,name)";
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

// The RPC accepts JSON numbers only, so numeric strings from form controls are converted here.
const toRequirementPayload = (input) => ({
  venuePreferences: Array.isArray(input.venuePreferences)
    ? input.venuePreferences.map(Number)
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

const toApi = (row, viewerUserId) => {
  const venuePreferences = row.venue_preferences || row.event_venue_preference;
  const equipmentRequirements = row.equipment_requirements || row.event_equipment_requirement;
  return {
    eventId: row.event_id,
    requestId: formatRequestId(row.event_id),
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    statusNote: toStatusNote(row),
    title: row.title,
    purpose: row.purpose,
    description: row.description,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    expectedAttendance: row.expected_attendance,
    preferredLayoutType: row.preferred_layout_type,
    accessibilityNeeds: parseAccessibility(row.accessibility_needs),
    venuePreferences: Array.isArray(venuePreferences)
      ? venuePreferences
          .slice()
          .sort((left, right) => (left.preference_order || 0) - (right.preference_order || 0))
          .map((item) => (typeof item === "number" ? item : item.venue_id))
      : [],
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
const toEventView = (row, user, access) => ({
  ...toApi(row, user.user_id),
  ...(access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR
    ? {
        coordinatorId: row.coordinator_id,
        organiser: row.organiser
          ? { userId: row.organiser.user_id, name: row.organiser.name, email: row.organiser.email ?? null }
          : null,
      }
    : {}),
  viewerRelationship: access.relationship,
  permissions: {
    canEdit: access.canEdit,
    editableFields: access.editableFields,
    canViewDraftHistory: access.historyAudiences.includes(HISTORY_AUDIENCE.OWNER_ONLY),
    canViewStaffHistory: access.historyAudiences.includes(HISTORY_AUDIENCE.STAFF_ONLY),
  },
});

const toListItem = (row, viewerUserId) => ({
  eventId: row.event_id,
  requestId: formatRequestId(row.event_id),
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
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
  ...toListItem(row),
  purpose: row.purpose,
  venuePreferences: Array.isArray(row.event_venue_preference)
    ? row.event_venue_preference
        .slice()
        .sort((left, right) => (left.preference_order || 0) - (right.preference_order || 0))
        .map((item) => item.venue_id)
    : [],
  equipmentRequirements: Array.isArray(row.event_equipment_requirement)
    ? row.event_equipment_requirement.map((item) => ({
        equipmentId: item.equipment_id,
        quantity: item.quantity_requested,
      }))
    : [],
});

const computeRegistrationAvailability = ({
  status,
  is_registration_enabled,
  registration_capacity,
  registration_open_at,
  registration_close_at,
  registeredCount = 0,
  now = new Date(),
}) => {
  if (!is_registration_enabled) return "NOT_ENABLED";
  if (!["CONFIRMED", "PREPARATION"].includes(status)) return "CLOSED";

  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const openAt = registration_open_at ? new Date(registration_open_at).getTime() : null;
  const closeAt = registration_close_at ? new Date(registration_close_at).getTime() : null;

  // The window is half-open, [open, close): it closes at registration_close_at itself.
  if (openAt !== null && currentTime < openAt) return "CLOSED";
  if (closeAt !== null && currentTime >= closeAt) return "CLOSED";

  if (registration_capacity == null) return "OPEN";
  if (registeredCount >= registration_capacity) return "FULL_WAITLIST";
  return "OPEN";
};

// registration(count) is narrowed to REGISTERED seats by REGISTERED_SEATS_FILTER, so the
// list and the detail read capacity from the same embedded count.
const LIST_ATTENDEE_DISCOVERY_SELECT =
  "event_id,title,description,start_datetime,end_datetime,is_registration_enabled,registration_capacity,registration_open_at,registration_close_at,status,organisation(organisation_id,name),registration(count),venue_booking(status,room(venue(venue_id,name,address)))";
const REGISTERED_SEATS_FILTER = ["registration.registration_status", "REGISTERED"];

const ATTENDEE_DISCOVERY_STATUSES = ["CONFIRMED", "PREPARATION"];

const attendeeLocation = (bookings = []) => {
  // The legacy schema has no primary-venue flag. Publish only an unambiguous
  // approved venue; never choose an arbitrary booking or reveal pending ones.
  const venues = new Map();
  for (const booking of bookings ?? []) {
    const venue = booking.room?.venue;
    if (booking.status === "APPROVED" && venue) venues.set(venue.venue_id, venue);
  }
  if (venues.size !== 1) return null;
  const venue = venues.values().next().value;
  return [venue.name, venue.address].filter(Boolean).join(", ") || null;
};

const toAttendeeDiscoveryItem = (row) => {
  const location = attendeeLocation(row.venue_booking);
  const availability = computeRegistrationAvailability({
    status: row.status,
    is_registration_enabled: row.is_registration_enabled,
    registration_capacity: row.registration_capacity,
    registration_open_at: row.registration_open_at,
    registration_close_at: row.registration_close_at,
    registeredCount: row.registration?.[0]?.count ?? 0,
  });

  return {
    eventId: row.event_id,
    title: row.title,
    description: row.description,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    organisationName: row.organisation ? row.organisation.name : null,
    location,
    registrationAvailability: availability,
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
]);

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
  INVALID_EQUIPMENT_REQUIREMENTS: { equipmentRequirements: MESSAGES.equipmentRequirementsInvalid },
});

// Constraints are the final check (e.g. a stale draft merge); report them against the field.
const CONSTRAINT_FIELD_ERRORS = Object.freeze({
  event_expected_attendance_positive_check: { expectedAttendance: MESSAGES.attendanceInvalid },
  event_registration_capacity_positive_check: { registrationCapacity: MESSAGES.registrationCapacityInvalid },
  event_registration_enabled_capacity_check: { registrationCapacity: MESSAGES.registrationCapacityRequired },
  event_datetime_order_check: { endDatetime: MESSAGES.endBeforeStart },
  event_venue_preference_pkey: { venuePreferences: MESSAGES.venuePreferencesInvalid },
  event_venue_preference_venue_id_fkey: { venuePreferences: MESSAGES.venuePreferencesInvalid },
  event_equipment_requirement_pkey: { equipmentRequirements: MESSAGES.equipmentRequirementsInvalid },
  event_equipment_requirement_equipment_id_fkey: { equipmentRequirements: MESSAGES.equipmentRequirementsInvalid },
});

const toEventRequestError = (error, fields) => {
  if (typeof error === "string") return eventRequestError(error, fields);
  const message = error.message || "";
  const code = error.code || "";

  if (DOMAIN_CODES.has(message)) return eventRequestError(message, error.fields);
  if (message === "INVALID_EVENT_SUBMISSION") {
    return eventRequestError("VALIDATION_FAILED", toFieldErrors(error.details, SUBMISSION_FAILURES));
  }
  if (message === "INVALID_EVENT_DETAILS") {
    return eventRequestError("VALIDATION_FAILED", toFieldErrors(error.details, DETAILS_FAILURES));
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
const findVisibleEvent = async (eventId, user) => {
  const select = user.role === "COORDINATOR" ? COORDINATION_SELECT : EVENT_SELECT;
  let query = supabase.from("event").select(select).eq("event_id", eventId);
  if (user.role === "COORDINATOR") {
    query = query.eq("coordinator_id", user.user_id).neq("status", "DRAFT");
  } else if (user.role === "ORGANISER") {
    query = query.or(buildOrganiserVisibilityFilter(user));
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
  venuePreferences: Array.isArray(row.event_venue_preference)
    ? row.event_venue_preference
        .slice()
        .sort((left, right) => (left.preference_order || 0) - (right.preference_order || 0))
        .map((item) => (typeof item === "number" ? item : item.venue_id))
    : [],
  equipmentRequirements: Array.isArray(row.event_equipment_requirement)
    ? row.event_equipment_requirement.map((item) => ({
        equipmentId: item.equipment_id,
        quantity: item.quantity_requested ?? item.quantity,
      }))
    : [],
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
      .not("status", "in", '("DRAFT","COMPLETED","REJECTED","CANCELLED")')
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

const reassignCoordinator = async ({ eventId, coordinatorId, expectedCoordinatorId, leadId }) => {
  const { data, error } = await supabase.rpc("reassign_event_coordinator", {
    p_event_id: eventId,
    p_coordinator_id: coordinatorId,
    p_expected_coordinator_id: expectedCoordinatorId,
    p_lead_id: leadId,
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
    throw new Error("reassign_event_coordinator returned an incomplete result.");
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
  };
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
// moving updated_at; event_id breaks ties between equal timestamps.
const findOrganiserEventRequests = async (user, { limit, cursor = null, status = null }) => {
  const after = decodeCursor(cursor);
  let query = supabase.from("event").select(LIST_SELECT).or(buildOrganiserVisibilityFilter(user));
  if (status) query = query.eq("status", status);
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
    .eq(...REGISTERED_SEATS_FILTER)
    .eq("is_published", true)
    .in("status", ATTENDEE_DISCOVERY_STATUSES)
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

const toLookupIds = (values) =>
  Array.isArray(values)
    ? [...new Set(values.map(toWholeNumber))]
        .filter((id) => Number.isInteger(id) && id > 0 && id <= MAX_INTEGER)
        .slice(0, MAX_LOOKUP_IDS)
    : [];

const NO_ROWS = { data: [], error: null };

// Looks up only the layout, venues and equipment this request mentions, so an
// auto-save does not read whole catalogue tables.
const findValidationContext = async (input) => {
  const layout = typeof input.preferredLayoutType === "string" ? input.preferredLayoutType.trim() : "";
  const venueIds = toLookupIds(input.venuePreferences);
  const equipmentIds = toLookupIds(
    Array.isArray(input.equipmentRequirements)
      ? input.equipmentRequirements.map((item) => (item && typeof item === "object" ? item.equipmentId : null))
      : []
  );

  const [layouts, venues, equipment] = await Promise.all([
    layout && layout !== NO_LAYOUT_PREFERENCE
      ? supabase.from("room").select("layout_type").eq("layout_type", layout).limit(1)
      : NO_ROWS,
    venueIds.length ? supabase.from("venue").select("venue_id").in("venue_id", venueIds) : NO_ROWS,
    equipmentIds.length
      ? supabase.from("equipment").select("equipment_id").in("equipment_id", equipmentIds)
      : NO_ROWS,
  ]);
  for (const result of [layouts, venues, equipment]) {
    if (result.error) throw dbError(result.error);
  }

  return {
    allowedLayouts: [NO_LAYOUT_PREFERENCE, ...layouts.data.map((room) => room.layout_type)],
    venueIds: venues.data.map(({ venue_id }) => venue_id),
    equipmentIds: equipment.data.map(({ equipment_id }) => equipment_id),
  };
};

// Request creation only needs catalogue names/IDs and supported layouts.
// This read does not reserve a venue or expose internal venue planning data.
const findRequestOptions = async () => {
  const [venues, rooms] = await Promise.all([
    supabase.from("venue").select("venue_id,name").order("name", { ascending: true }),
    supabase.from("room").select("layout_type"),
  ]);
  for (const result of [venues, rooms]) if (result.error) throw dbError(result.error);
  return {
    venues: venues.data.map(row => ({ venueId: row.venue_id, name: row.name })),
    layouts: [...new Set([NO_LAYOUT_PREFERENCE, ...rooms.data.map(row => row.layout_type)])].filter(Boolean),
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
  findCoordinatorEvents,
  findUnassignedSubmittedEvents,
  findCoordinatorAvailability,
  findLeadAssignments,
  assignCoordinator,
  reassignCoordinator,
  findOwnEvent,
  findOrganiserEventRequests,
  findPublishedAttendeeEvents,
  findPublishedAttendeeEvent,
  computeRegistrationAvailability,
  encodeCursor,
  decodeCursor,
  encodeDiscoveryCursor,
  decodeDiscoveryCursor,
  findValidationContext,
};
