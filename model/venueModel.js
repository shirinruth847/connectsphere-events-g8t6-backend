const supabase = require("../config/supabase");
const venueDetailModel = require("./venueDetailModel");
const venueCalendarModel = require("./venueCalendarModel");
const venueConflictModel = require("./venueConflictModel");
const activityModel = require("./activityModel");
const { VENUE_STATUS } = require("../config/venueConstants");
const { MESSAGES } = require("../validators/venueValidator");
const { formatRequestId, parseAccessibility } = require("./eventModel");
const { EVENT_STATUS, EVENT_TYPE_LABELS, VENUE_BOOKING_STATUS_LABELS } = require("../config/eventConstants");

const VENUE_SELECT = `venue_id,name,address,max_capacity,operating_hours,accessibility_features,setup_turnaround_min,rooms:room(room_id,layout_type,capacity)`;
const MANAGED_VENUE_SELECT = `venue_id,name,address,max_capacity,status,status_reason,contact_person,contact_email,contact_number,version,created_at,updated_at,created_by,updated_by`;

// ---------- catalogue (SPM-72) ----------

// detailStatus is the only signal for the MongoDB fields: CURRENT (document
// read), NOT_AVAILABLE (MongoDB read, no document) or NOT_CHECKED (MongoDB
// unavailable, Master M4). Fields without a value are null in every case.
const mapVenue = (row, details, detailStatus) => ({
  venueId: row.venue_id,
  name: row.name,
  address: row.address,
  maxCapacity: row.max_capacity,
  operatingHours: row.operating_hours,
  // PostgreSQL keeps a free-text accessibility note; the detail document's list
  // replaces it when present.
  accessibilityFeatures: details?.accessibilityFeatures
    ?? (row.accessibility_features ? [row.accessibility_features] : null),
  // Legacy PostgreSQL value, read-only; MongoDB owns the minutes (Master 1.2, T27).
  setupTurnaroundMinutes: row.setup_turnaround_min,
  setupMinutes: details?.setupMinutes ?? null,
  turnaroundMinutes: details?.turnaroundMinutes ?? null,
  rooms: (row.rooms || []).map((room) => ({
    roomId: room.room_id,
    layoutType: room.layout_type,
    capacity: room.capacity,
  })),
  detailStatus,
  description: details?.description ?? null,
  facilities: details?.facilities ?? null,
  supportedLayouts: details?.supportedLayouts ?? null,
  emergencyAccess: details?.emergencyAccess ?? null,
  knownRestrictions: details?.knownRestrictions ?? null,
});

// A PostgREST or() value matching text literally inside ilike: % and _ are
// escaped for LIKE, then the value is double-quoted so commas and brackets in
// the search cannot change the filter.
const orIlike = (columns, text) => {
  const pattern = `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
  const quoted = `"${pattern.replace(/["\\]/g, (character) => `\\${character}`)}"`;
  return columns.map((column) => `${column}.ilike.${quoted}`).join(",");
};

const includesText = (list, text) => (list || []).some((item) => String(item).toLowerCase().includes(text.toLowerCase()));

// Detail filters read MongoDB (Master 5.4.5). Without MongoDB, layout and
// accessibility fall back to the PostgreSQL room layouts and accessibility
// note; facilities cannot be checked and are reported as not checked (M4).
const matchesDetailFilters = (row, details, { layout, facility, accessibility }, detailsRead) => {
  const layouts = [...(details?.supportedLayouts || []), ...(row.rooms || []).map((room) => room.layout_type)];
  if (layout && !includesText(layouts, layout)) return false;
  if (facility && detailsRead && !includesText(details?.facilities, facility)) return false;
  const accessibilityList = details?.accessibilityFeatures ?? (row.accessibility_features ? [row.accessibility_features] : []);
  if (accessibility && !includesText(accessibilityList, accessibility)) return false;
  return true;
};

// Available venues only: not deleted as unusable (is_active, SPM-72) and in
// service (status ACTIVE, SPM-73). Deleted and inactive rows are kept for history.
// filters: search (name or address), minCapacity, layout, facility, accessibility.
const getVenueCatalogue = async (filters = {}) => {
  let query = supabase
    .from("venue")
    .select(VENUE_SELECT)
    .eq("is_active", true)
    .eq("status", VENUE_STATUS.ACTIVE);
  if (filters.search) query = query.or(orIlike(["name", "address"], filters.search));
  if (filters.minCapacity) query = query.gte("max_capacity", filters.minCapacity);
  const { data, error } = await query
    .order("name", { ascending: true })
    .order("venue_id", { ascending: true });
  if (error) throw error;

  const rows = data || [];
  let details = null;
  try {
    details = await venueDetailModel.getVenueDetailsByIds(rows.map((row) => row.venue_id));
  } catch (mongoError) {
    console.warn("[venue-catalogue] MongoDB detail read unavailable", { code: mongoError.code });
  }

  const venues = rows
    .filter((row) => matchesDetailFilters(row, details?.get(String(row.venue_id)), filters, Boolean(details)))
    .map((row) => {
      if (!details) return mapVenue(row, null, "NOT_CHECKED");
      const document = details.get(String(row.venue_id));
      return mapVenue(row, document, document ? "CURRENT" : "NOT_AVAILABLE");
    });
  return {
    venues,
    detailsAvailable: Boolean(details),
    filtersNotChecked: !details && filters.facility ? ["facility"] : [],
  };
};

// ---------- maintenance (SPM-73) ----------

const venueError = (code, extra = {}) => Object.assign(new Error(code), { name: "VenueError", code, ...extra });

// Database failures that are the client's fault become VenueErrors; anything
// else is rethrown and answered with a safe 500.
const RPC_ERRORS = new Set(["FORBIDDEN", "VENUE_NOT_FOUND", "VENUE_VERSION_CONFLICT", "VENUE_NAME_TAKEN"]);
const CONSTRAINT_FIELDS = Object.freeze({
  venue_max_capacity_positive_check: { maxCapacity: MESSAGES.capacityInvalid },
  venue_maintenance_reason_check: { reason: MESSAGES.reasonRequired },
});

const toVenueError = (error) => {
  const message = error.message || "";
  const code = error.code || "";
  if (RPC_ERRORS.has(message)) return venueError(message);
  if (message === "VENUE_HAS_UPCOMING_BOOKINGS") {
    let details = {};
    try {
      details = JSON.parse(error.details || "{}");
    } catch {
      // Keep the warning even if the detail cannot be read.
    }
    return venueError("VENUE_HAS_UPCOMING_BOOKINGS", {
      upcomingBookings: details.upcomingBookings ?? null,
      firstStart: details.firstStart ?? null,
    });
  }
  const constraint = /constraint "([^"]+)"/.exec(message);
  if (constraint && CONSTRAINT_FIELDS[constraint[1]]) return venueError("VALIDATION_FAILED", { fields: CONSTRAINT_FIELDS[constraint[1]] });
  if (code.startsWith("22")) return venueError("VALIDATION_FAILED", { fields: {} });
  return error;
};

const toPerson = (userId, names) => (userId ? { userId, name: names.get(userId) ?? null } : null);

const toManagedVenue = (row, names = new Map()) => ({
  venueId: row.venue_id,
  name: row.name,
  address: row.address,
  maxCapacity: row.max_capacity,
  status: row.status,
  statusReason: row.status_reason,
  contactPerson: row.contact_person,
  contactEmail: row.contact_email,
  contactNumber: row.contact_number,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdBy: toPerson(row.created_by, names),
  updatedBy: toPerson(row.updated_by, names),
});

const findUserNames = async (rows) => {
  const ids = [...new Set(rows.flatMap((row) => [row.created_by, row.updated_by]).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from("user").select("user_id,name").in("user_id", ids);
  if (error) throw error;
  return new Map(data.map((user) => [user.user_id, user.name]));
};

// LIKE treats % and _ as wildcards; escape them so a search matches literally.
const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

// Venue Staff list: every venue not deleted as unusable, whatever its status,
// filtered by name, location (address) and status, case-insensitively.
const listManagedVenues = async ({ search, location, status }, { limit, offset }) => {
  let query = supabase.from("venue").select(MANAGED_VENUE_SELECT).eq("is_active", true);
  if (search) query = query.ilike("name", `%${escapeLike(search)}%`);
  if (location) query = query.ilike("address", `%${escapeLike(location)}%`);
  if (status) query = query.eq("status", status);
  // One extra row tells whether another page exists.
  const { data, error } = await query
    .order("name", { ascending: true })
    .order("venue_id", { ascending: true })
    .range(offset, offset + limit);
  if (error) throw error;

  const rows = data.slice(0, limit);
  const names = await findUserNames(rows);
  return {
    venues: rows.map((row) => toManagedVenue(row, names)),
    nextOffset: data.length > limit ? offset + limit : null,
  };
};

const findManagedVenueRow = async (venueId) => {
  const { data, error } = await supabase
    .from("venue")
    .select(MANAGED_VENUE_SELECT)
    .eq("venue_id", venueId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const getManagedVenue = async (venueId) => {
  const row = await findManagedVenueRow(venueId);
  if (!row) throw venueError("VENUE_NOT_FOUND");
  return toManagedVenue(row, await findUserNames([row]));
};

const callVenueRpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw toVenueError(error);
  if (!data || !data.venue) throw new Error(`${name} returned no venue.`);
  return {
    venue: toManagedVenue(data.venue, await findUserNames([data.venue])),
    changed: data.changed === true,
    upcomingBookings: data.upcoming_bookings ?? 0,
  };
};

const createVenue = (actorId, values) =>
  callVenueRpc("create_venue", { p_actor_id: actorId, p_venue: values });

const updateVenue = (actorId, venueId, version, changes) =>
  callVenueRpc("update_venue", {
    p_actor_id: actorId,
    p_venue_id: venueId,
    p_expected_version: version,
    p_changes: changes,
  });

const setVenueStatus = (actorId, venueId, { version, status, reason, confirmUpcomingBookings }) =>
  callVenueRpc("set_venue_status", {
    p_actor_id: actorId,
    p_venue_id: venueId,
    p_expected_version: version,
    p_status: status,
    p_reason: reason,
    p_confirm_upcoming: confirmUpcomingBookings,
  });

// ---------- MongoDB venue details (SPM-73, Master 6.4, 7.4, T27) ----------

const toVenueDetails = (document) => {
  const details = Object.fromEntries(venueDetailModel.EDITABLE_DETAIL_FIELDS.map((field) => [field, document?.[field] ?? null]));
  for (const field of ["facilities", "accessibilityFeatures", "supportedLayouts", "knownRestrictions"]) details[field] = details[field] || [];
  return {
    ...details,
    version: document?.version ?? 0,
    updatedAt: document?.updatedAt ? new Date(document.updatedAt).toISOString() : null,
  };
};

// { details, detailStatus }: CURRENT, NOT_AVAILABLE (no document yet) or
// NOT_CHECKED (MongoDB unavailable; details is then null and cannot be edited).
const getManagedVenueDetails = async (venueId) => {
  try {
    const document = await venueDetailModel.getVenueDetail(venueId);
    return { details: toVenueDetails(document), detailStatus: document ? "CURRENT" : "NOT_AVAILABLE" };
  } catch (error) {
    console.warn("[venue-details] MongoDB detail read unavailable", { code: error.code });
    return { details: null, detailStatus: "NOT_CHECKED" };
  }
};

const ACTIVE_BOOKING_STATUSES = ["PENDING", "APPROVED"];

// Bookings (PostgreSQL) that still occupy the venue after now.
const findFutureActiveBookings = async (venueId) => {
  const { data, error } = await supabase
    .from("venue_booking")
    .select("booking_id,booking_reference,event_id,status,start_datetime,end_datetime,room:room!inner(venue_id)")
    .eq("room.venue_id", venueId)
    .in("status", ACTIVE_BOOKING_STATUSES)
    .gt("end_datetime", new Date().toISOString())
    .order("start_datetime", { ascending: true });
  if (error) throw error;
  return data || [];
};

const mongoUnavailable = (error) => {
  console.warn("[venue-details] MongoDB unavailable", { code: error.code, name: error.name });
  return venueError("VENUE_DETAILS_UNAVAILABLE");
};

// Saves the MongoDB details Venue Staff edit. Setup/turnaround changes are
// refused while a booking or hold still occupies the venue in the future, and
// the response lists them (Master 5.4.1, T16). The audit entry is appended to
// PostgreSQL after the MongoDB write (Master 7.4 step 3).
const updateVenueDetails = async (actorId, venueId, version, values) => {
  const row = await findManagedVenueRow(venueId);
  if (!row) throw venueError("VENUE_NOT_FOUND");

  let current;
  try {
    current = await venueDetailModel.getVenueDetail(venueId);
  } catch (error) {
    throw mongoUnavailable(error);
  }
  if ((current?.version ?? 0) !== version) throw venueError("VENUE_DETAILS_VERSION_CONFLICT");

  const changes = {};
  for (const [field, value] of Object.entries(values)) {
    const before = current?.[field] ?? (Array.isArray(value) ? [] : null);
    if (JSON.stringify(before) !== JSON.stringify(value)) changes[field] = { before, after: value };
  }
  if (!Object.keys(changes).length) return { details: toVenueDetails(current), changed: false };

  if (changes.setupMinutes || changes.turnaroundMinutes) {
    const now = new Date();
    let holds;
    try {
      holds = await venueCalendarModel.findFutureActiveHolds(venueId, now);
    } catch (error) {
      throw mongoUnavailable(error);
    }
    const bookings = await findFutureActiveBookings(venueId);
    if (bookings.length || holds.length) {
      throw venueError("VENUE_HAS_FUTURE_COMMITMENTS", {
        commitments: [
          ...bookings.map((booking) => ({
            type: "BOOKING",
            bookingReference: booking.booking_reference,
            requestId: formatRequestId(booking.event_id),
            status: booking.status,
            start: booking.start_datetime,
            end: booking.end_datetime,
          })),
          ...holds.map((hold) => ({
            type: "HOLD",
            requestId: hold.eventId ? formatRequestId(hold.eventId) : null,
            status: "ACTIVE",
            start: new Date(hold.start).toISOString(),
            end: new Date(hold.end).toISOString(),
          })),
        ],
      });
    }
  }

  const changedValues = Object.fromEntries(Object.keys(changes).map((field) => [field, values[field]]));
  let saved;
  try {
    saved = await venueDetailModel.saveVenueDetails({
      venueId,
      expectedVersion: version,
      fields: changedValues,
      name: row.name,
      location: row.address,
      pgVersion: row.version,
      actorId,
    });
  } catch (error) {
    if (error.name === "VenueError") throw error;
    throw mongoUnavailable(error);
  }

  try {
    await activityModel.appendActivity({
      userId: actorId,
      entityName: "venue",
      entityId: venueId,
      action: "VENUE_DETAILS_UPDATED",
      details: `Venue details updated: ${Object.keys(changes).sort().join(", ")}`,
      changes,
      audience: "STAFF_ONLY",
    });
  } catch (error) {
    // The MongoDB change stands; the missing audit entry is reported for follow-up.
    console.error("[venue-details] audit entry not written", { venueId, code: error.code });
  }
  return { details: toVenueDetails(saved), changed: true };
};

// ---------- availability calendar (SPM-74, Master 5.4.5) ----------

const AVAILABILITY_VENUE_SELECT = "venue_id,name,address,operating_hours,status";
// Bookings are loaded a day either side of the range: setup and turnaround are
// at most 1440 minutes each, so nothing that can occupy the range is missed.
const BUFFER_MARGIN_MS = 24 * 60 * 60 * 1000;

// Venue Staff see event titles; a coordinator sees them only for events
// assigned to them (Master 4.2). Everyone sees the references.
const canSeeEventTitle = (viewer, event) =>
  viewer.role === "VENUE_STAFF" || (event?.coordinator_id != null && event.coordinator_id === viewer.user_id);

const getVenueAvailability = async ({ from, to, venueIds = [], check = null }, viewer) => {
  let venueQuery = supabase.from("venue").select(AVAILABILITY_VENUE_SELECT).eq("is_active", true);
  venueQuery = venueIds.length ? venueQuery.in("venue_id", venueIds) : venueQuery.eq("status", VENUE_STATUS.ACTIVE);
  const { data: venueRows, error: venueListError } = await venueQuery
    .order("name", { ascending: true })
    .order("venue_id", { ascending: true });
  if (venueListError) throw venueListError;
  const venues = venueRows || [];
  if (!venues.length) return { from: from.toISOString(), to: to.toISOString(), venues: [] };
  const ids = venues.map((venue) => venue.venue_id);

  const { data: bookingRows, error: bookingError } = await supabase
    .from("venue_booking")
    .select("booking_id,booking_reference,status,start_datetime,end_datetime,event_id,room:room!inner(venue_id),event:event!inner(event_id,title,coordinator_id)")
    .in("room.venue_id", ids)
    .in("status", ACTIVE_BOOKING_STATUSES)
    .lt("start_datetime", new Date(to.getTime() + BUFFER_MARGIN_MS).toISOString())
    .gt("end_datetime", new Date(from.getTime() - BUFFER_MARGIN_MS).toISOString());
  if (bookingError) throw bookingError;

  // Without MongoDB the minutes, holds and blocks are unknown, so nothing may
  // be shown as available (Master 7.4 step 5, SPM-74 TC13).
  let details;
  let calendarEntries;
  try {
    [details, calendarEntries] = await Promise.all([
      venueDetailModel.getVenueDetailsByIds(ids),
      venueCalendarModel.findCalendarEntries(
        ids,
        new Date(from.getTime() - BUFFER_MARGIN_MS),
        new Date(to.getTime() + BUFFER_MARGIN_MS)
      ),
    ]);
  } catch (error) {
    console.warn("[venue-availability] MongoDB unavailable", { code: error.code, name: error.name });
    throw venueError("AVAILABILITY_UNAVAILABLE");
  }

  const holdEventIds = [...new Set(calendarEntries.map((entry) => entry.eventId).filter(Boolean))];
  const holdEvents = new Map();
  if (holdEventIds.length) {
    const { data, error } = await supabase.from("event").select("event_id,title,coordinator_id").in("event_id", holdEventIds);
    if (error) throw error;
    for (const event of data || []) holdEvents.set(event.event_id, event);
  }

  const now = new Date();
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    generatedAt: now.toISOString(),
    venues: venues.map((row) => {
      const document = details.get(String(row.venue_id));
      const venue = {
        operatingHours: row.operating_hours,
        setupMinutes: document?.setupMinutes ?? null,
        turnaroundMinutes: document?.turnaroundMinutes ?? null,
      };
      const bookings = (bookingRows || [])
        .filter((booking) => booking.room.venue_id === row.venue_id)
        .map((booking) => ({
          bookingId: booking.booking_id,
          bookingReference: booking.booking_reference,
          status: booking.status,
          start: booking.start_datetime,
          end: booking.end_datetime,
          eventId: booking.event_id,
          requestId: formatRequestId(booking.event_id),
          eventTitle: canSeeEventTitle(viewer, booking.event) ? booking.event.title : null,
        }));
      const entries = calendarEntries
        .filter((entry) => entry.venueId === row.venue_id)
        .map((entry) => {
          const event = entry.eventId ? holdEvents.get(entry.eventId) : null;
          return {
            ...entry,
            requestId: entry.eventId ? formatRequestId(entry.eventId) : null,
            eventTitle: event && canSeeEventTitle(viewer, event) ? event.title : null,
          };
        });
      return {
        venueId: row.venue_id,
        name: row.name,
        address: row.address,
        status: row.status,
        ...venue,
        // A venue without MongoDB minutes cannot receive holds or bookings (Master 5.4.1).
        buffersRecorded: venue.setupMinutes != null && venue.turnaroundMinutes != null,
        ...venueConflictModel.buildVenueCalendar({ venue, bookings, calendarEntries: entries, from, to, now, requested: check }),
      };
    }),
  };
};

// ---------- venue booking review (SPM-181) ----------

const BOOKING_VENUE_SELECT =
  "room:room!inner(room_id,layout_type,capacity,venue:venue!inner(venue_id,name,address,max_capacity,operating_hours,setup_turnaround_min))";
const BOOKING_FIELDS =
  "booking_id,booking_reference,label,status,start_datetime,end_datetime,expected_attendance,layout_type,required_facilities,accessibility_requirements,special_requirements,rejection_reason,created_at,event_id";
const BOOKING_LIST_SELECT = `${BOOKING_FIELDS},${BOOKING_VENUE_SELECT},event:event!inner(event_id,title,event_type,status)`;
const BOOKING_DETAIL_SELECT = `${BOOKING_FIELDS},${BOOKING_VENUE_SELECT}`;
// Venue Staff see the event's venue-relevant details and the coordinator's
// name, never participant data, organiser contact details or internal notes
// (Master section 4.2).
const BOOKING_EVENT_SELECT =
  "event_id,title,event_type,status,purpose,description,start_datetime,end_datetime,expected_attendance,preferred_layout_type,accessibility_needs,submitted_at,organisation(name),coordinator:user!event_coordinator_id_fkey(name)";

const toEventType = (eventType) => ({
  eventType: eventType ?? null,
  eventTypeLabel: eventType ? EVENT_TYPE_LABELS[eventType] || eventType : null,
});

const toBookingVenue = (room) => ({
  venueId: room.venue.venue_id,
  name: room.venue.name,
  address: room.venue.address,
  maxCapacity: room.venue.max_capacity,
  operatingHours: room.venue.operating_hours,
  setupTurnaroundMinutes: room.venue.setup_turnaround_min,
  roomId: room.room_id,
  roomLayoutType: room.layout_type,
  roomCapacity: room.capacity,
});

const toBookingSummary = (row) => ({
  bookingId: row.booking_id,
  bookingReference: row.booking_reference,
  label: row.label,
  status: row.status,
  statusLabel: VENUE_BOOKING_STATUS_LABELS[row.status] || row.status,
  venueId: row.room.venue.venue_id,
  venueName: row.room.venue.name,
  startDatetime: row.start_datetime,
  endDatetime: row.end_datetime,
  expectedAttendance: row.expected_attendance,
  submittedAt: row.created_at,
});

const toBookingListItem = (row) => ({
  ...toBookingSummary(row),
  event: {
    eventId: row.event.event_id,
    requestId: formatRequestId(row.event.event_id),
    title: row.event.title,
    status: row.event.status,
    ...toEventType(row.event.event_type),
  },
});

const toBookingDetail = (row) => ({
  ...toBookingSummary(row),
  venue: toBookingVenue(row.room),
  layoutType: row.layout_type,
  requiredFacilities: row.required_facilities || [],
  accessibilityRequirements: row.accessibility_requirements || [],
  specialRequirements: row.special_requirements,
  rejectionReason: row.rejection_reason,
});

const toBookingEvent = (row) => {
  const accessibilityNeeds = parseAccessibility(row.accessibility_needs);
  return {
    eventId: row.event_id,
    requestId: formatRequestId(row.event_id),
    title: row.title,
    status: row.status,
    ...toEventType(row.event_type),
    purpose: row.purpose,
    description: row.description,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    expectedAttendance: row.expected_attendance,
    preferredLayoutType: row.preferred_layout_type,
    accessibilityNeeds: Array.isArray(accessibilityNeeds) ? accessibilityNeeds : accessibilityNeeds ? [accessibilityNeeds] : [],
    submittedAt: row.submitted_at,
    organisationName: row.organisation?.name ?? null,
    coordinatorName: row.coordinator?.name ?? null,
  };
};

const findVenueBookings = async ({ status, venueId, eventId, from, to, limit }) => {
  let query = supabase.from("venue_booking").select(BOOKING_LIST_SELECT);
  if (status) query = query.eq("status", status);
  if (venueId) query = query.eq("room.venue_id", venueId);
  if (eventId) query = query.eq("event_id", eventId);
  // Half-open overlap with the requested day(s) (Master section 5.4).
  if (from && to) query = query.lt("start_datetime", to).gt("end_datetime", from);
  query = query
    .order("start_datetime", { ascending: true })
    .order("booking_id", { ascending: true })
    .limit(limit + 1);

  const [list, pending] = await Promise.all([
    query,
    supabase.from("venue_booking").select("booking_id", { count: "exact", head: true }).eq("status", "PENDING"),
  ]);
  if (list.error) throw list.error;
  if (pending.error) throw pending.error;

  const rows = list.data || [];
  return {
    bookings: rows.slice(0, limit).map(toBookingListItem),
    hasMore: rows.length > limit,
    pendingCount: pending.count ?? 0,
  };
};

// The event and every booking under it, or null when the event has no
// bookings or is still a private draft: Venue Staff reach events only
// through their bookings.
const findEventBookings = async (eventId) => {
  const [eventResult, bookingResult] = await Promise.all([
    supabase.from("event").select(BOOKING_EVENT_SELECT).eq("event_id", eventId).maybeSingle(),
    supabase
      .from("venue_booking")
      .select(BOOKING_DETAIL_SELECT)
      .eq("event_id", eventId)
      .order("start_datetime", { ascending: true })
      .order("booking_id", { ascending: true }),
  ]);
  if (eventResult.error) throw eventResult.error;
  if (bookingResult.error) throw bookingResult.error;

  const event = eventResult.data;
  const bookings = bookingResult.data || [];
  if (!event || event.status === EVENT_STATUS.DRAFT || !bookings.length) return null;

  return { event: toBookingEvent(event), bookings: bookings.map(toBookingDetail) };
};

const findVenueBooking = async (bookingId) => {
  const { data, error } = await supabase
    .from("venue_booking")
    .select("event_id")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const context = await findEventBookings(data.event_id);
  const booking = context?.bookings.find((item) => item.bookingId === bookingId);
  if (!booking) return null;

  return {
    booking,
    event: context.event,
    otherBookings: context.bookings
      .filter((item) => item.bookingId !== bookingId)
      .map(({ bookingId: id, bookingReference, label, status, statusLabel, venueId, venueName, startDatetime, endDatetime }) => ({
        bookingId: id,
        bookingReference,
        label,
        status,
        statusLabel,
        venueId,
        venueName,
        startDatetime,
        endDatetime,
      })),
  };
};

module.exports = {
  getVenueCatalogue,
  listManagedVenues,
  findManagedVenueRow,
  getManagedVenue,
  createVenue,
  updateVenue,
  setVenueStatus,
  getManagedVenueDetails,
  updateVenueDetails,
  getVenueAvailability,
  findVenueBookings,
  findEventBookings,
  findVenueBooking,
};
