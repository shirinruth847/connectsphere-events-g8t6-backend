// SPM-199: read-only, organiser-safe projections. Authorisation happens before
// any of these service-role reads in requireVisibleEvent and the controller.
const supabase = require("../config/supabase");
const calendar = require("./venueCalendarModel");
const { getVenueDetailsByIds } = require("./venueDetailModel");
const { occupiedRange, overlaps, isHoldActive } = require("./venueConflictModel");

const ACTIVE_BOOKINGS = ["PENDING", "APPROVED"];
const unavailable = () => ({ status: "UNAVAILABLE" });
const missingTable = (error) => ["42P01", "PGRST205"].includes(error?.code);
const rows = async (query) => {
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
};
const optionalRows = async (query) => {
  try { return await rows(query); }
  catch (error) { if (missingTable(error)) return null; throw error; }
};
const safely = async (read) => {
  try { return await read(); }
  catch (error) {
    // Never send provider diagnostics, internal notes or raw records to clients.
    console.error("[SPM-199] arrangement section unavailable", { code: error.code, name: error.name });
    return unavailable();
  }
};

const pendingAction = "Your coordinator will decide the next action.";
const RESOLUTIONS = {
  RESTORED: "The original venue booking has been restored.",
  REPLACED: "A replacement venue has been arranged.",
  RELEASED: "The affected venue booking has been released.",
  EVENT_CANCELLED: "The event has been cancelled.",
};

function impactFor(bookingId, range, venueId, entries, incidents, { active = true, venueUnavailable = false } = {}) {
  const linked = (incidents || []).filter((item) => item.booking_id === bookingId);
  const blocked = active && entries?.some((entry) => entry.type === "BLOCK" && entry.status === "ACTIVE"
    && entry.venueId === venueId && overlaps(range, { start: entry.occupiedStart, end: entry.occupiedEnd }));
  if (blocked || (active && (venueUnavailable || linked.some((item) => item.status === "OPEN")))) {
    return { status: "AFFECTED", message: "This venue arrangement is affected by unavailability.", nextAction: pendingAction };
  }
  const resolved = linked.find((item) => item.status === "RESOLVED" && RESOLUTIONS[item.resolution]);
  if (resolved) return { status: "RESOLVED", message: "A venue availability issue was resolved.", nextAction: RESOLUTIONS[resolved.resolution] };
  if (!active) return { status: "INACTIVE", message: null, nextAction: null };
  // Missing calendar/buffer information must not be presented as an all-clear.
  return { status: entries && incidents ? "NOT_REPORTED" : "UNKNOWN", message: null, nextAction: null };
}

async function readVenues(event) {
  // '*' is kept server-side so the same reader can consume the existing room
  // schema and the agreed venue_id/is_primary draft when it is deployed. Only
  // the explicit projection below leaves the backend.
  const bookings = await rows(supabase.from("venue_booking")
    .select("*,room(room_id,venue(venue_id,name))")
    .eq("event_id", event.event_id).order("start_datetime").order("booking_id"));
  const [holdResult, incidentResult] = await Promise.all([
    safely(() => calendar.findEventHolds(event.event_id)),
    safely(() => optionalRows(supabase.from("resource_incidents")
      .select("incident_id,booking_id,status,resolution").eq("event_id", event.event_id)
      .eq("type", "VENUE_BLOCK").order("created_at", { ascending: false }))),
  ]);
  const holds = Array.isArray(holdResult) ? holdResult : [];
  const incidents = Array.isArray(incidentResult) ? incidentResult : null;
  const venueIdFor = (booking) => booking.venue_id ?? booking.room?.venue?.venue_id;
  const ids = [...new Set([...bookings.map(venueIdFor), ...holds.map((hold) => hold.venueId)].filter(Boolean))];
  const venues = ids.length ? await rows(supabase.from("venue").select("venue_id,name,status,is_active").in("venue_id", ids)) : [];
  const details = await safely(() => getVenueDetailsByIds(ids));
  const ranges = new Map(bookings.map((booking) => {
    const detail = details instanceof Map ? details.get(String(venueIdFor(booking))) : null;
    const known = Number.isInteger(detail?.setupMinutes) && Number.isInteger(detail?.turnaroundMinutes);
    return [booking.booking_id, known ? occupiedRange(booking.start_datetime, booking.end_datetime, detail.setupMinutes, detail.turnaroundMinutes) : null];
  }));
  const allRanges = [...ranges.values()].filter(Boolean).concat(holds.map((hold) => ({ start: hold.occupiedStart, end: hold.occupiedEnd })));
  const entriesResult = allRanges.length ? await safely(() => calendar.findCalendarEntries(ids,
    new Date(Math.min(...allRanges.map((range) => new Date(range.start).getTime()))),
    new Date(Math.max(...allRanges.map((range) => new Date(range.end).getTime()))))) : [];
  const entries = Array.isArray(entriesResult) ? entriesResult : null;
  return { bookings, holds, holdResult, incidents, venues, details, ranges, entries };
}

// Keep the read context server-side and project only after all sections and the
// event-version check have completed, using the same clock for expiry and impact.
function projectVenues({ bookings, holds, holdResult, incidents, venues, details, ranges, entries }, now) {
  const names = new Map(venues.map((venue) => [venue.venue_id, venue.name]));
  const unavailableVenues = new Set(venues.filter((venue) => venue.is_active === false
    || ["INACTIVE", "UNDER_MAINTENANCE"].includes(venue.status)).map((venue) => venue.venue_id));
  const active = bookings.filter((booking) => ACTIVE_BOOKINGS.includes(booking.status));
  const explicitPrimary = bookings.some((booking) => typeof booking.is_primary === "boolean");
  return {
    status: "READY",
    holdsStatus: Array.isArray(holdResult) ? "READY" : "UNAVAILABLE",
    availabilityStatus: entries && details instanceof Map && bookings.every((booking) => ranges.get(booking.booking_id)) && incidents ? "READY" : "UNAVAILABLE",
    primaryVenueStatus: (explicitPrimary ? active.some((booking) => booking.is_primary === true) : active.length === 1) ? "READY" : "NOT_DESIGNATED",
    bookings: bookings.map((booking) => {
      const venueId = booking.venue_id ?? booking.room?.venue?.venue_id;
      const range = ranges.get(booking.booking_id);
      return {
        bookingId: booking.booking_id,
        label: booking.label ?? null,
        venueId,
        venueName: names.get(venueId) ?? booking.room?.venue?.name ?? "Venue name unavailable",
        startDatetime: booking.start_datetime,
        endDatetime: booking.end_datetime,
        status: booking.status,
        // Match the existing SPM-173 interim primary rule until an explicit
        // flag exists. Multiple legacy bookings never imply a guessed primary.
        isPrimary: ACTIVE_BOOKINGS.includes(booking.status) && (explicitPrimary ? booking.is_primary === true : active.length === 1),
        impact: impactFor(booking.booking_id, range, venueId, range ? entries : null, incidents, {
          active: ACTIVE_BOOKINGS.includes(booking.status) && new Date(range?.end ?? booking.end_datetime) > now,
          venueUnavailable: unavailableVenues.has(venueId),
        }),
      };
    }),
    holds: holds.map((hold) => {
      const status = hold.status === "ACTIVE" && !isHoldActive(hold, now) ? "EXPIRED" : hold.status;
      return {
        holdId: hold.id,
        label: hold.label,
        venueName: names.get(hold.venueId) ?? "Venue name unavailable",
        startDatetime: hold.start,
        endDatetime: hold.end,
        holdExpiresAt: hold.holdExpiresAt,
        status,
        impact: impactFor(null, { start: hold.occupiedStart, end: hold.occupiedEnd }, hold.venueId, entries, null, {
          active: status === "ACTIVE" && new Date(hold.occupiedEnd ?? hold.end) > now,
          venueUnavailable: unavailableVenues.has(hold.venueId),
        }),
      };
    }),
  };
}

async function readTechnical(event) {
  const requirements = await rows(supabase.from("event_equipment_requirement")
    .select("equipment_id,quantity_requested,equipment(name)").eq("event_id", event.event_id).order("equipment_id"));
  const canonical = await optionalRows(supabase.from("technical_requests")
    .select("request_id,status,support_required,technical_request_lines(equipment_id,quantity,equipment(name))")
    .eq("event_id", event.event_id).order("created_at", { ascending: false }).order("request_id", { ascending: false }));
  const legacy = canonical?.length ? [] : await rows(supabase.from("equipment_request")
    .select("equip_request_id,equipment_id,quantity_requested,status,start_datetime,end_datetime,equipment(name)")
    .eq("event_id", event.event_id).order("request_datetime", { ascending: false }).order("equip_request_id", { ascending: false }));
  const item = (line, quantity) => ({ equipmentId: line.equipment_id, name: line.equipment?.name ?? "Equipment name unavailable", quantity });
  return {
    status: "READY",
    supportStatus: canonical === null ? "UNAVAILABLE" : "READY",
    requirements: requirements.map((line) => item(line, line.quantity_requested)),
    requests: canonical?.length ? canonical.map((request) => ({
      requestId: request.request_id,
      status: request.status,
      supportRequired: request.support_required,
      equipment: (request.technical_request_lines || []).map((line) => item(line, line.quantity)),
    })) : legacy.map((request) => ({
      requestId: request.equip_request_id,
      status: request.status,
      supportRequired: null,
      equipment: [item(request, request.quantity_requested)],
    })),
  };
}

async function readSafety(event) {
  const reviews = await rows(supabase.from("safety_reviews")
    .select("review_id,round_number,arrangement_version,status,organiser_comment,submitted_at,decided_at")
    .eq("event_id", event.event_id).order("round_number", { ascending: false }));
  return {
    status: "READY",
    reviews: reviews.map((review, index) => ({
      reviewId: review.review_id,
      round: review.round_number,
      status: review.status,
      isCurrent: index === 0 && review.arrangement_version === event.arrangement_version && review.status !== "SUPERSEDED",
      organiserComment: review.organiser_comment,
      submittedAt: review.submitted_at,
      decidedAt: review.decided_at,
    })),
  };
}

async function findOrganiserArrangements(event, clock = () => new Date()) {
  if (event.status === "DRAFT") return {
    venues: { status: "READY", holdsStatus: "READY", availabilityStatus: "READY", primaryVenueStatus: "NOT_DESIGNATED", bookings: [], holds: [] },
    technical: { status: "READY", supportStatus: "READY", requirements: [], requests: [] },
    safety: { status: "READY", reviews: [] },
  };
  const [venueData, technical, safety] = await Promise.all([
    safely(() => readVenues(event)), safely(() => readTechnical(event)), safely(() => readSafety(event)),
  ]);
  // Resource writers advance arrangement_version (and event updates advance
  // version). Check after all reads so a concurrent edit cannot pair newer
  // bookings with an approval for the previous arrangement. This is an
  // optimistic consistency check, not a transaction across PostgreSQL/MongoDB.
  const { data: current, error } = await supabase.from("event")
    .select("arrangement_version,version,status").eq("event_id", event.event_id).maybeSingle();
  if (error) throw error;
  if (!current || ["arrangement_version", "version", "status"].some((key) => current[key] !== event[key])) {
    const changed = new Error("Arrangements changed while loading.");
    changed.code = "ARRANGEMENTS_CHANGED";
    throw changed;
  }
  // Read the clock after *all* I/O, including the version check. A hold can
  // expire while another section is loading, even without a database write.
  const now = clock();
  const venues = venueData.status === "UNAVAILABLE" ? venueData : await safely(() => projectVenues(venueData, now));
  return { venues, technical, safety };
}

module.exports = { findOrganiserArrangements };
