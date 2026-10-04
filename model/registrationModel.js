const supabase = require("../config/supabase");

const ATTENDEE_REGISTRATION_COLUMNS =
  "registration_id, registration_status, registration_datetime, event(event_id, title, description, start_datetime, end_datetime, status, venue_booking(status, room(venue(name, address))))";

// Internal planning states are collapsed so attendees never see review progress.
const ATTENDEE_VISIBLE_STATUSES = ["CONFIRMED", "COMPLETED", "CANCELLED"];
const VENUE_VISIBLE_STATUSES = ["CONFIRMED", "COMPLETED"];

const toAttendeeEvent = (event) => {
  const approvedBooking = VENUE_VISIBLE_STATUSES.includes(event.status)
    ? event.venue_booking.find((booking) => booking.status === "APPROVED")
    : undefined;
  const venue = approvedBooking && approvedBooking.room ? approvedBooking.room.venue : null;

  return {
    event_id: event.event_id,
    title: event.title,
    description: event.description,
    start_datetime: event.start_datetime,
    end_datetime: event.end_datetime,
    status: ATTENDEE_VISIBLE_STATUSES.includes(event.status) ? event.status : "PENDING_CONFIRMATION",
    venue: venue ? { name: venue.name, address: venue.address } : null,
  };
};

const findAttendeeRegistrations = async (attendeeId) => {
  const { data, error } = await supabase
    .from("registration")
    .select(ATTENDEE_REGISTRATION_COLUMNS)
    .eq("attendee_id", attendeeId)
    .neq("registration_status", "WITHDRAWN")
    .order("registration_datetime", { ascending: false });

  if (error) {
    throw new Error(`[Supabase Error] ${error.message}`);
  }

  return data.map((registration) => ({
    registration_id: registration.registration_id,
    registration_status: registration.registration_status,
    registered_at: registration.registration_datetime,
    event: toAttendeeEvent(registration.event),
  }));
};

module.exports = { findAttendeeRegistrations, toAttendeeEvent };
