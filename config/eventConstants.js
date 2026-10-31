// Values must match the public.event_status enum exactly (Master section 5.2).
// The enum's unused APPROVED value is left out: no lifecycle action reaches it.
const EVENT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  UNDER_REVIEW: "UNDER_REVIEW",
  AWAITING_CLARIFICATION: "AWAITING_CLARIFICATION",
  PLANNING: "PLANNING",
  SAFETY_REVIEW: "SAFETY_REVIEW",
  CONFIRMED: "CONFIRMED",
  PREPARATION: "PREPARATION",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  CANCELLED: "CANCELLED",
});

const USER_ROLES = Object.freeze({
  ORGANISER: "ORGANISER",
  COORDINATOR: "COORDINATOR",
  COORDINATOR_LEAD: "COORDINATOR_LEAD",
});

const NOTIFICATION_TYPES = Object.freeze({
  STATUS_CHANGE: "STATUS_CHANGE",
});

// Organiser-facing label for each stored status (Master section 3.5). An
// unknown status falls back to its stored code.
const STATUS_LABELS = Object.freeze({
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under Review",
  AWAITING_CLARIFICATION: "Under Review",
  PLANNING: "Approved & Planning",
  SAFETY_REVIEW: "Approved & Planning",
  CONFIRMED: "Confirmed",
  PREPARATION: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REJECTED: "Rejected",
});

// The statuses behind each organiser label, so a label filter is expanded on
// the backend (SPM-173 AC6). Built from STATUS_LABELS so the two cannot drift.
const LABEL_STATUSES = Object.freeze(
  Object.entries(STATUS_LABELS).reduce((byLabel, [status, label]) => {
    byLabel[label] = Object.freeze([...(byLabel[label] || []), status]);
    return byLabel;
  }, {})
);

// Organiser-facing notes, the "flag" column of Master section 3.5. Shown only
// while the note is true. WAITING_FOR_COORDINATOR is an SPM-33 addition the
// Master does not list yet.
const STATUS_NOTES = Object.freeze({
  WAITING_FOR_COORDINATOR: "Waiting for a coordinator",
  RETURNED_FOR_ACTION: "Returned – action required",
  RECONFIRMATION_PENDING: "Reconfirmation pending",
});

// Coordinator lifecycle actions (Master section 5.2), each using one database
// function under the event lock. SPM-39 adds feasibility acceptance to SPM-173.
const LIFECYCLE_ACTIONS = Object.freeze({
  ACCEPT_FEASIBILITY: Object.freeze({ rpc: "accept_event_feasibility", message: "Event request approved for planning." }),
  SUBMIT_FOR_SAFETY_REVIEW: Object.freeze({ rpc: "submit_event_for_safety_review", message: "Event submitted for safety review." }),
  CONFIRM: Object.freeze({ rpc: "confirm_event", message: "Event confirmed." }),
  START_PREPARATION: Object.freeze({ rpc: "start_event_preparation", message: "Event preparation started." }),
  COMPLETE: Object.freeze({ rpc: "complete_event", message: "Event completed." }),
});

// Why an event is not ready for safety review or confirmation (Master section
// 5.3), by the code the database reports.
const READINESS_MESSAGES = Object.freeze({
  NO_ACTIVE_BOOKING: "Add at least one venue booking.",
  BOOKING_NOT_APPROVED: "Every venue booking must be approved; holds and pending requests do not count.",
  BOOKING_OVER_CAPACITY: "A booking's expected attendance is larger than its venue's capacity.",
  BOOKING_CONFLICT: "A venue booking overlaps another active booking at the same venue.",
  // Interim wording until bookings carry a primary flag (SPM-173 interim readiness).
  NO_PRIMARY_VENUE: "Keep exactly one active venue booking: it becomes the primary venue. Events at several venues cannot be submitted until a primary venue can be chosen.",
  TECHNICAL_NOT_APPROVED: "The technical request must be approved, or marked as not required.",
  REGISTRATION_INVALID: "Registration is enabled without a valid capacity.",
  REGISTRATION_EXCEEDS_PRIMARY_CAPACITY: "Registration capacity is larger than the primary venue's capacity.",
  OPEN_BLOCKING_INCIDENT: "A venue or equipment incident is still open.",
  READINESS_DATA_PENDING: "Incident readiness data is unavailable; try again after the resource schema is deployed.",
  OPEN_CHANGE_REQUEST: "A change request is still open.",
});

const NO_LAYOUT_PREFERENCE = "NO_PREFERENCE";
const MIN_LEAD_TIME_HOURS = 48;

// How a signed-in user relates to an event they are allowed to see (SPM-33 AC1).
const EVENT_RELATIONSHIP = Object.freeze({
  OWNER: "OWNER",
  ORGANISATION_MEMBER: "ORGANISATION_MEMBER",
  ASSIGNED_COORDINATOR: "ASSIGNED_COORDINATOR",
  SAFETY_OFFICER: "SAFETY_OFFICER", // the event has a round in their queue, held or decided by them (SPM-243 AC2)
  // The Lead who made the current assignment, read-only (Master 4.2, T19, T23).
  SUPERVISING_LEAD: "SUPERVISING_LEAD",
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
    "technicalSupportNeeds",
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
    "submittedAt",
    "supervisingLeadId",
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
// section 5.2 lifecycle order. SUBMITTED is absent because an event in it has no
// coordinator, and there is no APPROVED state.
// Where the assigned coordinator may suggest a venue to the organiser (SPM-72/74);
// suggest_event_venue checks the same list.
const VENUE_SUGGESTION_STATUSES = Object.freeze(["UNDER_REVIEW", "PLANNING"]);

const COORDINATOR_EDITABLE_STATUSES = Object.freeze([
  "UNDER_REVIEW",
  "PLANNING",
  "SAFETY_REVIEW",
  "CONFIRMED",
  "PREPARATION",
]);

// SPM-41: the coordinator's opening question and every thread message are
// required and at most this long (team decision, 2026-10-20).
const CLARIFICATION_TEXT_LIMIT = 2000;

// What the owner may amend while a clarification thread is open: every
// submission field except registration settings and the organisation (team
// decision). These changes skip the change workflow (Master 5.2).
// SPM-35: the registration window can be amended; the flag and capacity cannot.
const AMENDMENT_FIELDS = Object.freeze([
  ...EVENT_FIELD_GROUPS.ORDINARY,
  ...EVENT_FIELD_GROUPS.SIGNIFICANT,
  "registrationOpenAt",
  "registrationCloseAt",
]);

// safety_reviews.status values (Master 6.2).
const SAFETY_ROUND_STATUS = Object.freeze({
  OPEN: "OPEN",
  APPROVED: "APPROVED",
  CHANGES_REQUESTED: "CHANGES_REQUESTED",
  REJECTED: "REJECTED",
  SUPERSEDED: "SUPERSEDED",
});

// The change history a Safety Officer reads: changes to attendance, timing,
// venues and layout, access and equipment (Master 5.9), plus every safety
// review entry. Field names match activity_log.changes keys; "venueBookings"
// is the venue booking request entry (SPM-179).
const SAFETY_REVIEW_HISTORY_FIELDS = Object.freeze([
  "expectedAttendance",
  "startDatetime",
  "endDatetime",
  "venuePreferences",
  "venueBookings",
  "preferredLayoutType",
  "accessibilityNeeds",
  "equipmentRequirements",
]);

// The event history Venue Staff read (SPM-186, Master 4.2 "relevant portion"):
// venue entries (VENUE_*) and changes to what a venue booking depends on.
const VENUE_STAFF_HISTORY_FIELDS = Object.freeze([
  "startDatetime",
  "endDatetime",
  "expectedAttendance",
  "preferredLayoutType",
  "accessibilityNeeds",
  "venuePreferences",
  "venueBookings",
]);

// Values of the event_type check constraint (SPM-181) and their display labels.
const EVENT_TYPE_LABELS = Object.freeze({
  CONFERENCE: "Conference",
  WORKSHOP: "Workshop",
  SEMINAR: "Seminar",
  NETWORKING: "Networking",
  SOCIAL: "Social",
  TRAINING: "Training",
  OTHER: "Other",
});

// Staff-facing venue booking labels (SPM-181); the frontend never maps states.
const VENUE_BOOKING_STATUS_LABELS = Object.freeze({
  HELD: "Held",
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  RELEASED: "Released",
  CANCELLED: "Cancelled",
});

module.exports = {
  EVENT_STATUS,
  USER_ROLES,
  NOTIFICATION_TYPES,
  STATUS_LABELS,
  LABEL_STATUSES,
  STATUS_NOTES,
  EVENT_TYPE_LABELS,
  VENUE_BOOKING_STATUS_LABELS,
  LIFECYCLE_ACTIONS,
  READINESS_MESSAGES,
  NO_LAYOUT_PREFERENCE,
  MIN_LEAD_TIME_HOURS,
  EVENT_RELATIONSHIP,
  HISTORY_AUDIENCE,
  VENUE_STAFF_HISTORY_FIELDS,
  EVENT_FIELD_GROUPS,
  OWNER_DRAFT_FIELDS,
  COORDINATOR_EDITABLE_STATUSES,
  CLARIFICATION_TEXT_LIMIT,
  AMENDMENT_FIELDS,
  SAFETY_ROUND_STATUS,
  SAFETY_REVIEW_HISTORY_FIELDS,
  VENUE_SUGGESTION_STATUSES,
};
