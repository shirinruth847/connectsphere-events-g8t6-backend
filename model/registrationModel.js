const supabase = require("../config/supabase");
const {
  hashRequest,
  attendeeVenue,
  findLatestConfirmationSnapshots,
  CONFIRMED_DETAIL_STATUSES,
  SNAPSHOT_DETAIL_STATUSES,
} = require("./eventModel");

const ATTENDEE_REGISTRATION_COLUMNS =
  "registration_id, registration_status, registration_datetime, event(event_id, title, description, start_datetime, end_datetime, status, is_published, venue_booking(status, room(venue(venue_id, name, address))))";

// Attendees see a display status instead of the lifecycle state, so internal
// review and planning progress never reaches them. PENDING_CONFIRMATION is a
// display value only, never an event state. PREPARATION is a staff stage of a
// confirmed event, so attendees see it as CONFIRMED (SPM-173).
const ATTENDEE_STATUSES = Object.freeze({
  CONFIRMED: "CONFIRMED",
  PREPARATION: "CONFIRMED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
});

const toVenue = (venue) =>
  venue && typeof venue === "object" && (venue.name || venue.address)
    ? { name: venue.name ?? null, address: venue.address ?? null }
    : null;

// The same values GET /mine/:eventId shows (SPM-141, Master 5.3, 5.6): current
// values only for a published, confirmed event; the last published
// confirmation snapshot while an event is back in planning, in safety review
// or cancelled; otherwise only the title and status, because current values
// may be unconfirmed changes.
const toAttendeeEvent = (event, latestSnapshot = null) => {
  const view = {
    event_id: event.event_id,
    title: event.title,
    description: null,
    start_datetime: null,
    end_datetime: null,
    attendee_status: Object.hasOwn(ATTENDEE_STATUSES, event.status) ? ATTENDEE_STATUSES[event.status] : "PENDING_CONFIRMATION",
    venue: null,
  };
  if (event.is_published && CONFIRMED_DETAIL_STATUSES.includes(event.status)) {
    return {
      ...view,
      description: event.description,
      start_datetime: event.start_datetime,
      end_datetime: event.end_datetime,
      venue: toVenue(attendeeVenue(event.venue_booking)),
    };
  }
  const snapshot = SNAPSHOT_DETAIL_STATUSES.includes(event.status) ? latestSnapshot?.snapshot : null;
  if (snapshot && snapshot.is_published === true) {
    return {
      ...view,
      title: snapshot.title ?? event.title,
      description: snapshot.description ?? null,
      start_datetime: snapshot.start_datetime ?? null,
      end_datetime: snapshot.end_datetime ?? null,
      venue: toVenue(snapshot.primary_venue),
    };
  }
  return view;
};

const findAttendeeRegistrations = async (attendeeId, { limit, offset }) => {
  const { data, error } = await supabase
    .from("registration")
    .select(ATTENDEE_REGISTRATION_COLUMNS)
    .eq("attendee_id", attendeeId)
    .neq("registration_status", "WITHDRAWN")
    .order("registration_datetime", { ascending: false })
    .order("registration_id", { ascending: false })
    .range(offset, offset + limit);

  if (error) {
    throw new Error(`[Supabase Error] ${error.message}`);
  }

  const page = data.slice(0, limit);
  const snapshots = await findLatestConfirmationSnapshots([
    ...new Set(
      page.filter(({ event }) => SNAPSHOT_DETAIL_STATUSES.includes(event.status)).map(({ event }) => event.event_id)
    ),
  ]);
  const registrations = page.map((registration) => ({
    registration_id: registration.registration_id,
    registration_status: registration.registration_status,
    registered_at: registration.registration_datetime,
    event: toAttendeeEvent(registration.event, snapshots.get(registration.event.event_id) || null),
  }));

  return { registrations, nextOffset: data.length > limit ? offset + limit : null };
};

// ---------- registering for an event (SPM-134) ----------

// Raised by register_for_event; each becomes a stable API code.
const REGISTRATION_ERRORS = new Set([
  "EVENT_NOT_FOUND",
  "NOT_ATTENDEE",
  "ALREADY_REGISTERED",
  "ALREADY_WAITLISTED",
  "REGISTRATION_NOT_YET_OPEN",
  "REGISTRATION_CLOSED",
  "REGISTRATION_FULL",
  "REGISTRATION_UNAVAILABLE",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
]);

const registrationError = (code) => Object.assign(new Error(code), { name: "RegistrationError", code });

const toRegistrationError = (error) =>
  error.code === "P0001" && REGISTRATION_ERRORS.has(error.message)
    ? registrationError(error.message)
    : new Error(`[Supabase Error] ${error.message}`);

// The reference shown on the confirmation, from the committed registration ID.
const toConfirmationNumber = (registrationId) => `REG-${String(registrationId).padStart(6, "0")}`;

const toRegistrationConfirmation = ({ registration, event }) => ({
  registrationId: registration.registration_id,
  confirmationNumber: toConfirmationNumber(registration.registration_id),
  status: registration.registration_status,
  registeredAt: registration.registration_datetime,
  dietaryRestrictions: registration.dietary_restrictions,
  accessibilityRequirements: registration.accessibility_requirements,
  event: {
    eventId: event.event_id,
    title: event.title,
    startDatetime: event.start_datetime,
    endDatetime: event.end_datetime,
    organisationName: event.organisation_name,
  },
});

// One database transaction (register_for_event): event lock, window by
// database time, capacity recount, duplicate check, the registration with its
// answers, activity and the in-app confirmation. The attendee profile is read
// by the form, never written here.
const registerForEvent = async (attendeeId, eventId, { dietaryRestrictions, accessibilityRequirements }, idempotencyKey = null) => {
  const { data, error } = await supabase.rpc("register_for_event", {
    p_attendee_id: attendeeId,
    p_event_id: eventId,
    p_dietary_restrictions: dietaryRestrictions,
    p_accessibility_requirements: accessibilityRequirements,
    p_idempotency_key: idempotencyKey,
    p_request_hash: idempotencyKey ? hashRequest({ dietaryRestrictions, accessibilityRequirements }, {}, [eventId]) : null,
  });
  if (error) throw toRegistrationError(error);
  if (!data || !data.registration || !data.event) throw new Error("register_for_event returned no registration.");
  return { registration: toRegistrationConfirmation(data), replayed: data.replayed === true };
};

module.exports = { findAttendeeRegistrations, toAttendeeEvent, registerForEvent, toConfirmationNumber };
