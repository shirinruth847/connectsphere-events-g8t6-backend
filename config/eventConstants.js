// Values must match the public.event_status enum exactly (Master section 5.2).
const EVENT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  AWAITING_CLARIFICATION: "AWAITING_CLARIFICATION",
  PLANNING: "PLANNING",
  CONFIRMED: "CONFIRMED",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});

// Organiser-facing label for each stored status (Master section 3.5).
const STATUS_LABELS = Object.freeze({
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under Review",
});

// Organiser-facing notes that explain what a request is waiting for, in the
// spirit of the "flag" column of Master section 3.5 (this note is an SPM-33
// addition the Master does not list yet). Shown only while the note is true.
const STATUS_NOTES = Object.freeze({
  WAITING_FOR_COORDINATOR: "Waiting for a coordinator",
});

const NO_LAYOUT_PREFERENCE = "NO_PREFERENCE";
const MIN_LEAD_TIME_HOURS = 48;

// How a signed-in user relates to an event they are allowed to see (SPM-33 AC1).
const EVENT_RELATIONSHIP = Object.freeze({
  OWNER: "OWNER",
  ORGANISATION_MEMBER: "ORGANISATION_MEMBER",
  ASSIGNED_COORDINATOR: "ASSIGNED_COORDINATOR",
});

// Who may read a change-history entry. Values match activity_log.audience.
const HISTORY_AUDIENCE = Object.freeze({
  OWNER_ONLY: "OWNER_ONLY", // recorded while the request was a private draft
  ORGANISER_SAFE: "ORGANISER_SAFE",
  STAFF_ONLY: "STAFF_ONLY", // e.g. assignment and reassignment records
});

// SPM-33 field edit matrix, by API field name. A known field outside the
// user's editable set is a permission error; any other key is a bad request.
const EVENT_FIELD_GROUPS = Object.freeze({
  ORDINARY: Object.freeze(["title", "purpose", "description"]),
  SIGNIFICANT: Object.freeze([
    "startDatetime",
    "endDatetime",
    "expectedAttendance",
    "venuePreferences",
    "preferredLayoutType",
    "equipmentRequirements",
    "accessibilityNeeds",
  ]),
  REGISTRATION: Object.freeze([
    "isRegistrationEnabled",
    "registrationCapacity",
    "registrationOpenAt",
    "registrationCloseAt",
  ]),
  SYSTEM: Object.freeze([
    "eventId",
    "requestId",
    "status",
    "organiserId",
    "coordinatorId",
    "organisationId",
    "isPublished",
  ]),
});

// What the owner may change while the request is a draft: the fields the
// draft API accepts (registration open and close times are not accepted yet).
const OWNER_DRAFT_FIELDS = Object.freeze([
  ...EVENT_FIELD_GROUPS.ORDINARY,
  ...EVENT_FIELD_GROUPS.SIGNIFICANT,
  "isRegistrationEnabled",
  "registrationCapacity",
]);

// Statuses in which the assigned coordinator may edit ordinary fields, in Master
// section 5.2 lifecycle order. Listed by name because SAFETY_REVIEW and PREPARATION
// are not in the live event_status enum yet. SUBMITTED is absent because an event
// in it has no coordinator, and there is no APPROVED state.
const COORDINATOR_EDITABLE_STATUSES = Object.freeze([
  "UNDER_REVIEW",
  "PLANNING",
  "SAFETY_REVIEW",
  "CONFIRMED",
  "PREPARATION",
]);

module.exports = {
  EVENT_STATUS,
  STATUS_LABELS,
  STATUS_NOTES,
  NO_LAYOUT_PREFERENCE,
  MIN_LEAD_TIME_HOURS,
  EVENT_RELATIONSHIP,
  HISTORY_AUDIENCE,
  EVENT_FIELD_GROUPS,
  OWNER_DRAFT_FIELDS,
  COORDINATOR_EDITABLE_STATUSES,
};
