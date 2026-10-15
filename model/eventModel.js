// All database access for event requests, plus conversion between API field
// names (camelCase) and database column names (snake_case).
const crypto = require("crypto");
const supabase = require("../config/supabase");
const { NO_LAYOUT_PREFERENCE, STATUS_LABELS } = require("../config/eventConstants");
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
  "*,organisation(organisation_id,name),event_venue_preference(venue_id,preference_order),event_equipment_requirement(equipment_id,quantity_requested)";
// List rows leave out purpose, requirements and other people's IDs (TC-AUTH-015).
const LIST_SELECT =
  "event_id,title,status,start_datetime,end_datetime,expected_attendance,organiser_id,coordinator_id,created_at,updated_at,organisation(organisation_id,name)";

// Calendar events include richer details for coordinators' schedule view.
const CALENDAR_SELECT =
  "event_id,title,status,start_datetime,end_datetime,expected_attendance,purpose,description,accessibility_needs,preferred_layout_type,is_registration_enabled,registration_capacity,coordinator_id,created_at,updated_at,organisation(organisation_id,name),event_venue_preference(venue_id,preference_order),event_equipment_requirement(equipment_id,quantity_requested)";

const MAX_LOOKUP_IDS = 50;

// ---------- input mapping ----------

const getUnsupportedInputFields = (body = {}, { allowAutoSave = false } = {}) =>
  Object.keys(body).filter((key) => !INPUT_FIELDS.has(key) && !(allowAutoSave && key === "isAutoSave"));

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
const hashRequest = (row, requirements) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([row, requirements.venuePreferences ?? null, requirements.equipmentRequirements ?? null]))
    .digest("hex");

// ---------- output mapping ----------

const formatRequestId = (eventId) => `REQ-${String(eventId).padStart(6, "0")}`;

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
    ...(row.organisation === undefined ? {} : { organisation: toOrganisation(row.organisation) }),
    isAssignedToCoordinator: row.coordinator_id != null,
    ...(viewerUserId === undefined ? {} : { isOwner: row.organiser_id === viewerUserId }),
  };
};

const toListItem = (row, viewerUserId) => ({
  eventId: row.event_id,
  requestId: formatRequestId(row.event_id),
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  title: row.title,
  startDatetime: row.start_datetime,
  endDatetime: row.end_datetime,
  expectedAttendance: row.expected_attendance,
  organisation: toOrganisation(row.organisation),
  isAssignedToCoordinator: row.coordinator_id != null,
  isOwner: row.organiser_id === viewerUserId,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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
  if (status !== "CONFIRMED") return "CLOSED";

  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const openAt = registration_open_at ? new Date(registration_open_at).getTime() : null;
  const closeAt = registration_close_at ? new Date(registration_close_at).getTime() : null;

  if (openAt !== null && currentTime < openAt) return "CLOSED";
  if (closeAt !== null && currentTime > closeAt) return "CLOSED";

  if (registration_capacity == null) return "OPEN";
  if (registeredCount >= registration_capacity) return "FULL_WAITLIST";
  return "OPEN";
};

const LIST_ATTENDEE_DISCOVERY_SELECT =
  "event_id,title,description,start_datetime,end_datetime,is_registration_enabled,registration_capacity,registration_open_at,registration_close_at,status,organisation(organisation_id,name)";

// PROVISIONAL Q6: add PREPARATION once the event_status migration includes it.
const ATTENDEE_DISCOVERY_STATUSES = ["CONFIRMED"];

const toAttendeeDiscoveryItem = (row) => {
  const location = null;
  const availability = computeRegistrationAvailability({
    status: row.status,
    is_registration_enabled: row.is_registration_enabled,
    registration_capacity: row.registration_capacity,
    registration_open_at: row.registration_open_at,
    registration_close_at: row.registration_close_at,
    registeredCount: row.registered_count ?? 0,
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
    organisationName: row.organisation ? row.organisation.name : null,
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
  "EVENT_NOT_FOUND",
  "EVENT_NOT_DRAFT",
  "NO_ELIGIBLE_COORDINATOR",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
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

const toEventRequestError = (error) => {
  const message = error.message || "";
  const code = error.code || "";

  if (DOMAIN_CODES.has(message)) return eventRequestError(message);
  if (message === "INVALID_EVENT_SUBMISSION") {
    const fields = {};
    for (const failure of String(error.details || "").split(",")) {
      if (SUBMISSION_FAILURES[failure]) fields[failure.split(":")[0]] = SUBMISSION_FAILURES[failure];
    }
    return eventRequestError("VALIDATION_FAILED", fields);
  }
  if (RPC_FIELD_ERRORS[message]) return eventRequestError("VALIDATION_FAILED", RPC_FIELD_ERRORS[message]);

  const constraint = /constraint "([^"]+)"/.exec(message);
  if (constraint && CONSTRAINT_FIELD_ERRORS[constraint[1]]) {
    return eventRequestError("VALIDATION_FAILED", CONSTRAINT_FIELD_ERRORS[constraint[1]]);
  }
  if (code === "23502" && /column "title"/.test(message)) {
    return eventRequestError("VALIDATION_FAILED", { title: MESSAGES.titleRequired });
  }
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

// Creating a draft (eventId null) needs an idempotency key; updates are naturally idempotent.
const saveDraft = async ({ organiserId, eventId = null, input, isAutoSave = false, idempotencyKey = null }) => {
  const row = toRow(input);
  const requirements = toRequirementPayload(input);
  return callEventRpc("save_event_draft", {
    p_organiser_id: organiserId,
    p_event_id: eventId,
    p_event: row,
    p_venue_preferences: requirements.venuePreferences ?? null,
    p_equipment_requirements: requirements.equipmentRequirements ?? null,
    p_is_auto_save: isAutoSave,
    p_idempotency_key: idempotencyKey,
    p_request_hash: idempotencyKey ? hashRequest(row, requirements) : null,
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

const findVisibleEvent = async (eventId, user) => {
  let query = supabase.from("event").select(EVENT_SELECT).eq("event_id", eventId);
  if (user.role === "COORDINATOR") {
    query = query.eq("coordinator_id", user.user_id).neq("status", "DRAFT");
  } else if (user.role === "ORGANISER") {
    query = query.or(buildOrganiserVisibilityFilter(user));
  } else {
    return null;
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw dbError(error);
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
    .select(LIST_SELECT)
    .eq("status", "SUBMITTED")
    .is("coordinator_id", null)
    .order("created_at", { ascending: true })
    .order("event_id", { ascending: true });
  if (error) throw dbError(error);
  return data;
};

const mapLeadAssignment = (row, coordinatorNames) => ({
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
  coordinatorId: row.coordinator_id,
  coordinatorName: coordinatorNames.get(row.coordinator_id) || "Inactive Coordinator",
});

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

const findLeadAssignments = async () => {
  const [{ data: events, error: eventsError }, { data: users, error: usersError }] = await Promise.all([
    supabase
      .from("event")
      .select(LIST_SELECT)
      .not("coordinator_id", "is", null)
      .not("status", "in", '("COMPLETED","REJECTED","CANCELLED")')
      .order("start_datetime", { ascending: true })
      .order("event_id", { ascending: true }),
    supabase.from("user").select("user_id,name").eq("role", "COORDINATOR"),
  ]);
  if (eventsError) throw dbError(eventsError);
  if (usersError) throw dbError(usersError);
  const coordinatorNames = new Map(users.map(({ user_id, name }) => [user_id, name]));
  return events.map((event) => mapLeadAssignment(event, coordinatorNames));
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
    if (["EVENT_NOT_FOUND", "INVALID_COORDINATOR", "COORDINATOR_CONFLICT"].includes(code)) {
      throw eventRequestError(code);
    }
    throw dbError(error);
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
    throw dbError(error);
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

// Edits are owner-only, so a colleague's visible request is "not found" here.
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

const encodeCursor = (row) =>
  Buffer.from(JSON.stringify({ updatedAt: row.updated_at, eventId: row.event_id })).toString("base64url");

const decodeCursor = (value) => {
  if (value === undefined || value === null) return null;
  let decoded = null;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    decoded = null;
  }
  if (
    !decoded ||
    typeof decoded.updatedAt !== "string" ||
    !CURSOR_TIMESTAMP.test(decoded.updatedAt) ||
    Number.isNaN(Date.parse(decoded.updatedAt)) ||
    !Number.isSafeInteger(decoded.eventId) ||
    decoded.eventId < 1
  ) {
    throw eventRequestError("INVALID_CURSOR");
  }
  return { updatedAt: decoded.updatedAt, eventId: decoded.eventId };
};

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

const findPublishedAttendeeEvents = async (user, { limit, cursor = null }) => {
  const after = decodeCursor(cursor);
  let query = supabase
    .from("event")
    .select(LIST_ATTENDEE_DISCOVERY_SELECT)
    .eq("is_published", true)
    .in("status", ATTENDEE_DISCOVERY_STATUSES)
    .gt("end_datetime", new Date().toISOString());
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
    events: page.map((row) => toAttendeeDiscoveryItem(row)),
    nextCursor: data.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
};

const findPublishedAttendeeEvent = async (eventId) => {
  const [eventResult, registrationResult] = await Promise.all([
    supabase
      .from("event")
      .select(LIST_ATTENDEE_DISCOVERY_SELECT)
      .eq("is_published", true)
      .in("status", ATTENDEE_DISCOVERY_STATUSES)
      .gt("end_datetime", new Date().toISOString())
      .eq("event_id", eventId)
      .maybeSingle(),
    supabase
      .from("registration")
      .select("event_id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("registration_status", "REGISTERED"),
  ]);

  const { data, error } = eventResult;
  if (error) throw dbError(error);
  if (!data) return null;

  const registeredCount = registrationResult?.count ?? 0;
  return {
    ...toAttendeeDetail({ ...data, registered_count: registeredCount }),
    registrationAvailability: computeRegistrationAvailability({
      status: data.status,
      is_registration_enabled: data.is_registration_enabled,
      registration_capacity: data.registration_capacity,
      registration_open_at: data.registration_open_at,
      registration_close_at: data.registration_close_at,
      registeredCount,
    }),
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

module.exports = {
  getUnsupportedInputFields,
  pickEventInput,
  toRow,
  toApi,
  toListItem,
  formatRequestId,
  hashRequest,
  toRequirementPayload,
  toEventRequestError,
  saveDraft,
  submitEvent,
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
  findValidationContext,
};
