const supabase = require("../config/supabase");
const venueDetailModel = require("./venueDetailModel");
const venueCalendarModel = require("./venueCalendarModel");
const venueConflictModel = require("./venueConflictModel");
const venuePhotoModel = require("./venuePhotoModel");
const activityModel = require("./activityModel");
const { VENUE_STATUS } = require("../config/venueConstants");
const { MESSAGES } = require("../validators/venueValidator");
const { formatRequestId, parseAccessibility, hashRequest } = require("./eventModel");
const { EVENT_STATUS, EVENT_TYPE_LABELS, VENUE_BOOKING_STATUS_LABELS } = require("../config/eventConstants");

const VENUE_SELECT = `venue_id,name,address,max_capacity,operating_hours,accessibility_features,setup_turnaround_min,rooms:room(room_id,layout_type,capacity)`;
const MANAGED_VENUE_SELECT = `venue_id,name,address,max_capacity,status,status_reason,contact_person,contact_email,contact_number,version,created_at,updated_at,created_by,updated_by`;

// ---------- catalogue (SPM-72) ----------

// detailStatus is the only signal for the MongoDB fields: CURRENT (document
// read), NOT_AVAILABLE (MongoDB read, no document) or NOT_CHECKED (MongoDB
// unavailable, Master M4). Fields without a value are null in every case.
const mapVenue = (row, details, detailStatus, relatedNames = new Map()) => ({
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
  // Linked venues that can still be chosen, by name; null when MongoDB was not read.
  relatedVenues: details === null && detailStatus === "NOT_CHECKED"
    ? null
    : (details?.relatedVenueIds || [])
      .filter((id) => relatedNames.has(String(id)))
      .map((id) => ({ venueId: Number(id), name: relatedNames.get(String(id)) })),
});

// Names of the related venues that are still available (active and in
// service), so a link never leads to a venue that cannot be chosen.
const getRelatedVenueNames = async (details) => {
  const ids = [...new Set([...details.values()].flatMap((document) => document.relatedVenueIds || []))]
    .map(Number)
    .filter(Number.isInteger);
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from("venue")
    .select("venue_id,name")
    .in("venue_id", ids)
    .eq("is_active", true)
    .eq("status", VENUE_STATUS.ACTIVE);
  if (error) throw error;
  return new Map((data || []).map((row) => [String(row.venue_id), row.name]));
};

// A PostgREST or() value matching text literally inside ilike: % and _ are
// escaped for LIKE, then the value is double-quoted so commas and brackets in
// the search cannot change the filter.
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
const quotedLike = (text) => `"${likePattern(text).replace(/["\\]/g, (character) => `\\${character}`)}"`;
const orIlike = (columns, text) => columns.map((column) => `${column}.ilike.${quotedLike(text)}`).join(",");

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
  // Internal only: the venues an event's organiser chose (SPM-72).
  if (filters.venueIds) query = query.in("venue_id", filters.venueIds);
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

  const relatedNames = details ? await getRelatedVenueNames(details) : new Map();
  const venues = rows
    .filter((row) => matchesDetailFilters(row, details?.get(String(row.venue_id)), filters, Boolean(details)))
    .map((row) => {
      if (!details) return mapVenue(row, null, "NOT_CHECKED");
      const document = details.get(String(row.venue_id));
      return mapVenue(row, document, document ? "CURRENT" : "NOT_AVAILABLE", relatedNames);
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

const toManagedVenue = (row, names = new Map(), details = undefined) => ({
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
  // MongoDB-owned minutes (T27), added to list rows; null when not recorded or not checked.
  ...(details === undefined ? {} : {
    setupMinutes: details?.setupMinutes ?? null,
    turnaroundMinutes: details?.turnaroundMinutes ?? null,
  }),
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

// My Venues sorts (SPM-181). PostgreSQL columns sort in the database; the
// MongoDB minutes sort in memory over the filtered list (at most
// MANAGED_SORT_SCAN_LIMIT venues), with unrecorded minutes last.
const MANAGED_SORT_COLUMNS = Object.freeze({ name: "name", capacity: "max_capacity", updatedAt: "updated_at" });
const DETAIL_SORT_FIELDS = Object.freeze(["setupMinutes", "turnaroundMinutes"]);
const MANAGED_SORT_SCAN_LIMIT = 1000;

const readDetailsOrNull = async (rows) => {
  try {
    return await venueDetailModel.getVenueDetailsByIds(rows.map((row) => row.venue_id));
  } catch (error) {
    console.warn("[venue-manage] MongoDB detail read unavailable", { code: error.code });
    return null;
  }
};

// First gallery photo per venue (T28); an empty Map when MongoDB is unavailable,
// so the cards fall back to the placeholder.
const readCoversOrEmpty = async (rows) => {
  try {
    return await venuePhotoModel.findCoverPhotoIds(rows.map((row) => row.venue_id));
  } catch (error) {
    console.warn("[venue-manage] MongoDB photo read unavailable", { code: error.code });
    return new Map();
  }
};

const withCover = (venue, covers) => ({ ...venue, coverPhotoId: covers.get(String(venue.venueId)) ?? null });

const compareMinutes = (field, ascending, details) => (a, b) => {
  const left = details.get(String(a.venue_id))?.[field];
  const right = details.get(String(b.venue_id))?.[field];
  if (left == null && right == null) return a.name.localeCompare(b.name) || a.venue_id - b.venue_id;
  if (left == null) return 1;
  if (right == null) return -1;
  return (ascending ? left - right : right - left) || a.name.localeCompare(b.name) || a.venue_id - b.venue_id;
};

// Venue Staff list: every venue not deleted as unusable, whatever its status,
// filtered by name, location (address) and status, case-insensitively.
const listManagedVenues = async ({ search, location, status, sort = "name", order = "asc" }, { limit, offset }) => {
  let query = supabase.from("venue").select(MANAGED_VENUE_SELECT).eq("is_active", true);
  if (search) query = query.ilike("name", `%${escapeLike(search)}%`);
  if (location) query = query.ilike("address", `%${escapeLike(location)}%`);
  if (status) query = query.eq("status", status);
  const ascending = order !== "desc";

  if (DETAIL_SORT_FIELDS.includes(sort)) {
    const { data, error } = await query
      .order("name", { ascending: true })
      .order("venue_id", { ascending: true })
      .range(0, MANAGED_SORT_SCAN_LIMIT - 1);
    if (error) throw error;
    const details = await readDetailsOrNull(data);
    // Without MongoDB the minutes are unknown: keep name order and say so.
    const sorted = details ? [...data].sort(compareMinutes(sort, ascending, details)) : data;
    const rows = sorted.slice(offset, offset + limit);
    const [names, covers] = await Promise.all([findUserNames(rows), readCoversOrEmpty(rows)]);
    return {
      venues: rows.map((row) => withCover(toManagedVenue(row, names, details ? details.get(String(row.venue_id)) ?? null : null), covers)),
      nextOffset: sorted.length > offset + limit ? offset + limit : null,
      detailsAvailable: Boolean(details),
      sortNotChecked: !details,
    };
  }

  // One extra row tells whether another page exists.
  const { data, error } = await query
    .order(MANAGED_SORT_COLUMNS[sort] || "name", { ascending })
    .order("venue_id", { ascending: true })
    .range(offset, offset + limit);
  if (error) throw error;

  const rows = data.slice(0, limit);
  const [names, details, covers] = await Promise.all([findUserNames(rows), readDetailsOrNull(rows), readCoversOrEmpty(rows)]);
  return {
    venues: rows.map((row) => withCover(toManagedVenue(row, names, details ? details.get(String(row.venue_id)) ?? null : null), covers)),
    nextOffset: data.length > limit ? offset + limit : null,
    detailsAvailable: Boolean(details),
    sortNotChecked: false,
  };
};

// Every venue not deleted as unusable, for filter and picker options. Read on
// demand, so a venue added, renamed or deleted appears in the next read.
const listVenueOptions = async () => {
  const { data, error } = await supabase
    .from("venue")
    .select("venue_id,name,status")
    .eq("is_active", true)
    .order("name", { ascending: true })
    .order("venue_id", { ascending: true });
  if (error) throw error;
  return { venues: (data || []).map((row) => ({ venueId: row.venue_id, name: row.name, status: row.status })) };
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
const BUFFER_FIELDS = ["setupMinutes", "turnaroundMinutes"];

const mongoUnavailable = (error) => {
  console.warn("[venue-details] MongoDB unavailable", { code: error.code, name: error.name });
  return venueError("VENUE_DETAILS_UNAVAILABLE");
};

// Saves the MongoDB details Venue Staff edit. Setup and turnaround minutes are
// set once each: a value already recorded can never change (Master 5.4.1,
// T16). The audit entry is appended to PostgreSQL after the MongoDB write
// (Master 7.4 step 3).
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

  const locked = BUFFER_FIELDS.filter((field) => changes[field] && current?.[field] != null);
  if (locked.length) throw venueError("VENUE_BUFFERS_LOCKED", { fields: locked });

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
      // The write re-checks that these are still unset (a concurrent first set loses).
      unsetFields: BUFFER_FIELDS.filter((field) => changes[field]),
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

// ---------- photo gallery (T28, SPM-181) ----------

const PHOTO_ERRORS = new Set(["PHOTO_NOT_FOUND", "PHOTO_LIMIT_REACHED"]);

// Every gallery call checks the venue in PostgreSQL first, so a deleted venue's
// photos are never served or changed.
const requireVenueRow = async (venueId) => {
  const row = await findManagedVenueRow(venueId);
  if (!row) throw venueError("VENUE_NOT_FOUND");
  return row;
};

const callPhotos = async (work) => {
  try {
    return await work();
  } catch (error) {
    if (error.name === "VenueError" && PHOTO_ERRORS.has(error.code)) throw error;
    console.warn("[venue-photos] MongoDB unavailable", { code: error.code, name: error.name });
    throw venueError("VENUE_PHOTOS_UNAVAILABLE");
  }
};

// The MongoDB change stands when the audit append fails (Master 7.4 step 3).
const auditPhoto = async (actorId, venueId, action, details, changes) => {
  try {
    await activityModel.appendActivity({
      userId: actorId,
      entityName: "venue",
      entityId: venueId,
      action,
      details,
      changes,
      audience: "STAFF_ONLY",
    });
  } catch (error) {
    console.error("[venue-photos] audit entry not written", { venueId, action, code: error.code });
  }
};

const listVenuePhotos = async (venueId) => {
  await requireVenueRow(venueId);
  return { photos: await callPhotos(() => venuePhotoModel.listPhotos(venueId)) };
};

const getVenuePhotoImage = async (venueId, photoId) => {
  await requireVenueRow(venueId);
  const image = await callPhotos(() => venuePhotoModel.getPhotoImage(venueId, photoId));
  if (!image) throw venueError("PHOTO_NOT_FOUND");
  return image;
};

const addVenuePhoto = async (actorId, venueId, upload) => {
  await requireVenueRow(venueId);
  const photo = await callPhotos(() => venuePhotoModel.addPhoto({ venueId, ...upload, actorId }));
  await auditPhoto(actorId, venueId, "VENUE_PHOTO_ADDED", `Venue photo added at position ${photo.position + 1}`, {
    photoId: { before: null, after: photo.photoId },
  });
  return photo;
};

const updateVenuePhoto = async (actorId, venueId, photoId, changes) => {
  await requireVenueRow(venueId);
  const photo = await callPhotos(() => venuePhotoModel.updatePhoto({ venueId, photoId, changes, actorId }));
  await auditPhoto(actorId, venueId, "VENUE_PHOTO_UPDATED", `Venue photo updated: ${Object.keys(changes).sort().join(", ")}`, {
    photoId: { before: photoId, after: photoId },
    ...Object.fromEntries(Object.entries(changes).map(([field, value]) => [field, { after: value }])),
  });
  return photo;
};

const replaceVenuePhotoImage = async (actorId, venueId, photoId, upload) => {
  await requireVenueRow(venueId);
  const photo = await callPhotos(() =>
    venuePhotoModel.replacePhotoImage({ venueId, photoId, contentType: upload.contentType, data: upload.data, size: upload.size, actorId }));
  await auditPhoto(actorId, venueId, "VENUE_PHOTO_REPLACED", "Venue photo image replaced", {
    photoId: { before: photoId, after: photoId },
  });
  return photo;
};

const deleteVenuePhoto = async (actorId, venueId, photoId) => {
  await requireVenueRow(venueId);
  const photo = await callPhotos(() => venuePhotoModel.deletePhoto({ venueId, photoId }));
  await auditPhoto(actorId, venueId, "VENUE_PHOTO_DELETED", "Venue photo deleted", {
    photoId: { before: photoId, after: null },
  });
  return photo;
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

// excludeEventId (internal only) leaves out one event's own bookings and holds,
// so an event's venue options never conflict with the event itself.
const getVenueAvailability = async ({ from, to, venueIds = [], check = null, excludeEventId = null }, viewer) => {
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
    .select("booking_id,status,start_datetime,end_datetime,event_id,room:room!inner(venue_id),event:event!inner(event_id,title,coordinator_id)")
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
        .filter((booking) => booking.room.venue_id === row.venue_id && booking.event_id !== excludeEventId)
        .map((booking) => ({
          bookingId: booking.booking_id,
          status: booking.status,
          start: booking.start_datetime,
          end: booking.end_datetime,
          eventId: booking.event_id,
          requestId: formatRequestId(booking.event_id),
          eventTitle: canSeeEventTitle(viewer, booking.event) ? booking.event.title : null,
        }));
      const entries = calendarEntries
        .filter((entry) => entry.venueId === row.venue_id && (excludeEventId == null || String(entry.eventId) !== String(excludeEventId)))
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

// ---------- event venue options (SPM-72/74) ----------

// Each requirement the event states is MET, UNMET or NOT_CHECKED (MongoDB could
// not be read, Master M4). Matching is advisory, like search (Master 5.4); the
// booking decision rechecks everything that blocks.
const REQUIREMENT_STATUS = Object.freeze({ MET: "MET", UNMET: "UNMET", NOT_CHECKED: "NOT_CHECKED" });
const NO_LAYOUT_PREFERENCE = "NO_PREFERENCE";
// Words too common to show that a venue meets a need on their own.
const COMMON_WORDS = new Set(["and", "the", "for", "with", "access", "accessible", "accessibility", "friendly", "free", "available", "none"]);

const normalise = (text) => String(text).toLowerCase().replace(/theatre/g, "theater").replace(/[^a-z0-9]+/g, " ").trim();

// A need is met when any listed feature contains one of its key words, or the
// whole need when it has none (for example "Ramp").
const listMeets = (list, need) => {
  const items = (list || []).map(normalise);
  const words = normalise(need).split(" ").filter((word) => word.length >= 3 && !COMMON_WORDS.has(word));
  const terms = words.length ? words : [normalise(need)];
  return items.some((item) => terms.some((term) => term && item.includes(term)));
};

const toNeedList = (value) => {
  const parsed = parseAccessibility(value);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((need) => typeof need === "string" && need.trim() && normalise(need) !== "none").map((need) => need.trim());
};

const requirement = (key, label, status, detail) => ({ key, label, status, detail });

// detailsRead is false when MongoDB was unavailable: PostgreSQL rooms and the
// accessibility note can still show a need as met, but never as unmet.
const venueRequirements = ({ venue, event, requiredFacilities, availability, detailsRead }) => {
  const list = [];
  const unknownUnlessMet = (met) => (met ? REQUIREMENT_STATUS.MET : detailsRead ? REQUIREMENT_STATUS.UNMET : REQUIREMENT_STATUS.NOT_CHECKED);

  if (event.expected_attendance != null) {
    const fits = venue.maxCapacity >= event.expected_attendance;
    list.push(requirement(
      "capacity",
      "Capacity",
      fits ? REQUIREMENT_STATUS.MET : REQUIREMENT_STATUS.UNMET,
      `Holds ${venue.maxCapacity.toLocaleString("en-SG")}; ${event.expected_attendance.toLocaleString("en-SG")} expected`
    ));
  }

  list.push(requirement("availability", "Availability", availability.requirementStatus, availability.detail));

  const layout = event.preferred_layout_type;
  if (layout && layout !== NO_LAYOUT_PREFERENCE) {
    const layouts = [...(venue.supportedLayouts || []), ...venue.rooms.map((room) => room.layoutType)];
    const met = layouts.some((item) => normalise(item) === normalise(layout));
    list.push(requirement("layout", "Layout", unknownUnlessMet(met), `${layout} layout`));
  }

  toNeedList(event.accessibility_needs).forEach((need, index) => {
    list.push(requirement(`accessibility-${index}`, "Accessibility", unknownUnlessMet(listMeets(venue.accessibilityFeatures, need)), need));
  });

  requiredFacilities.forEach((facility, index) => {
    const status = detailsRead
      ? (listMeets(venue.facilities, facility) ? REQUIREMENT_STATUS.MET : REQUIREMENT_STATUS.UNMET)
      : REQUIREMENT_STATUS.NOT_CHECKED;
    list.push(requirement(`facility-${index}`, "Facility", status, facility));
  });
  return list;
};

const describeConflicts = (conflicts, entries) => conflicts.map((conflict) => {
  const entry = entries.find((item) => item.entryId === conflict.entryId) || {};
  return {
    type: conflict.type,
    label: entry.label ?? conflict.type,
    occupiedStart: conflict.occupiedStart,
    occupiedEnd: conflict.occupiedEnd,
    holdExpiresAt: entry.holdExpiresAt ?? null,
    reasonLabel: entry.reasonLabel ?? null,
  };
});

const availabilitySummary = (status, label, requirementStatus, check = null, conflicts = []) => ({
  status,
  label,
  requirementStatus,
  // The requirement chip repeats the label, kept short (SPM-72 AC6).
  detail: label,
  occupiedStart: check?.occupiedStart ?? null,
  occupiedEnd: check?.occupiedEnd ?? null,
  conflicts,
  operatingHoursWarning: check?.operatingHoursWarning ?? null,
});

// The availability summary for one venue over the event's own window.
// hasDates is false for an event without dates (a draft cannot reach this).
const toOptionAvailability = (calendar, { hasDates = true } = {}) => {
  if (!hasDates) return availabilitySummary("NO_DATES", "Enter the event date", REQUIREMENT_STATUS.NOT_CHECKED);
  // MongoDB could not be read: never shown as available (Master 7.4 step 5).
  if (!calendar) return availabilitySummary("NOT_CHECKED", "Error checking availability", REQUIREMENT_STATUS.NOT_CHECKED);
  const { check } = calendar;
  const conflicts = describeConflicts(check.conflicts, calendar.entries);
  // A venue without setup/turnaround minutes cannot receive holds or bookings (Master 5.4.1).
  if (!calendar.buffersRecorded) {
    return availabilitySummary("NOT_BOOKABLE", "Not bookable yet", REQUIREMENT_STATUS.UNMET, check, conflicts);
  }
  return availabilitySummary(
    check.availability,
    check.availabilityLabel,
    check.canRequest ? REQUIREMENT_STATUS.MET : REQUIREMENT_STATUS.UNMET,
    check,
    conflicts
  );
};

const SORT_VALUES = Object.freeze({
  name: (venue) => venue.name.toLowerCase(),
  capacity: (venue) => venue.maxCapacity,
  setup: (venue) => venue.setupMinutes,
  turnaround: (venue) => venue.turnaroundMinutes,
});

// Venues meeting every requirement first, then fewest unmet; within a group,
// the chosen sort (missing values last), then name.
const compareOptions = (sort, order) => (left, right) => {
  if (left.unmetCount !== right.unmetCount) return left.unmetCount - right.unmetCount;
  const value = SORT_VALUES[sort];
  if (value) {
    const a = value(left);
    const b = value(right);
    if (a == null || b == null) {
      if (a != null || b != null) return a == null ? 1 : -1;
    } else if (a !== b) {
      return (a < b ? -1 : 1) * (order === "desc" ? -1 : 1);
    }
  }
  return left.name.localeCompare(right.name) || left.venueId - right.venueId;
};

// Each venue with its cover photo, availability over the event window and
// requirement statuses (SPM-72/74), unsorted. `need` holds the requirements
// in event-row shape: start_datetime, end_datetime, expected_attendance,
// preferred_layout_type and accessibility_needs. Nothing here writes.
const buildVenueOptions = async (catalogueVenues, need, viewer, { requiredFacilities, excludeEventId = null }) => {
  const ids = catalogueVenues.map((venue) => venue.venueId);

  let covers = new Map();
  try {
    covers = await venuePhotoModel.findCoverPhotoIds(ids);
  } catch (error) {
    console.warn("[venue-options] MongoDB photo read unavailable", { code: error.code });
  }

  const hasDates = Boolean(need.start_datetime && need.end_datetime);
  let calendars = null;
  if (ids.length && hasDates) {
    try {
      const window = { start: new Date(need.start_datetime), end: new Date(need.end_datetime) };
      const result = await getVenueAvailability(
        { from: window.start, to: window.end, venueIds: ids, check: window, excludeEventId },
        viewer
      );
      calendars = new Map(result.venues.map((venue) => [venue.venueId, venue]));
    } catch (error) {
      if (error.name !== "VenueError" || error.code !== "AVAILABILITY_UNAVAILABLE") throw error;
    }
  }

  const options = catalogueVenues.map(({ setupTurnaroundMinutes, ...venue }) => {
    const availability = toOptionAvailability(calendars?.get(venue.venueId) ?? null, { hasDates });
    const requirements = venueRequirements({
      venue,
      event: need,
      requiredFacilities,
      availability,
      detailsRead: venue.detailStatus !== "NOT_CHECKED",
    });
    const unmetCount = requirements.filter((item) => item.status !== REQUIREMENT_STATUS.MET).length;
    const { requirementStatus, detail, ...shownAvailability } = availability;
    return {
      ...venue,
      coverPhotoId: covers.get(String(venue.venueId)) ?? null,
      availability: shownAvailability,
      requirements,
      unmetCount,
      allRequirementsMet: unmetCount === 0,
    };
  });
  return { options, availabilityChecked: !hasDates || !ids.length || calendars !== null };
};

const preferredVenueIds = (event) =>
  (Array.isArray(event.event_venue_preference) ? event.event_venue_preference : [])
    .slice()
    .sort((left, right) => (left.preference_order || 0) - (right.preference_order || 0))
    .map((item) => item.venue_id);

const findVenueNames = async (venueIds) => {
  if (!venueIds.length) return new Map();
  const { data, error } = await supabase.from("venue").select("venue_id,name").in("venue_id", venueIds);
  if (error) throw error;
  return new Map((data || []).map((row) => [row.venue_id, row.name]));
};

// Available venues for one event, with each requirement marked (SPM-72/74),
// and the organiser's ranked choices whatever the filters (preferredVenues).
// A choice that is no longer available keeps its rank with option null.
// event is the visible event row; nothing here writes.
const getEventVenueOptions = async (event, viewer, { filters, requiredFacilities, sort, order }) => {
  const catalogue = await getVenueCatalogue(filters);
  const preferredIds = preferredVenueIds(event);
  const listedIds = new Set(catalogue.venues.map((venue) => venue.venueId));
  const unlistedIds = preferredIds.filter((venueId) => !listedIds.has(venueId));
  const extra = unlistedIds.length ? (await getVenueCatalogue({ venueIds: unlistedIds })).venues : [];

  const { options, availabilityChecked } = await buildVenueOptions([...catalogue.venues, ...extra], event, viewer, {
    requiredFacilities,
    excludeEventId: event.event_id,
  });
  const byId = new Map(options.map((option) => [option.venueId, option]));
  const names = await findVenueNames(preferredIds.filter((venueId) => !byId.has(venueId)));

  return {
    event: {
      eventId: event.event_id,
      requestId: formatRequestId(event.event_id),
      startDatetime: event.start_datetime,
      endDatetime: event.end_datetime,
      expectedAttendance: event.expected_attendance,
      preferredLayoutType: event.preferred_layout_type,
      accessibilityNeeds: toNeedList(event.accessibility_needs),
    },
    venues: catalogue.venues.map((venue) => byId.get(venue.venueId)).sort(compareOptions(sort, order)),
    preferredVenues: preferredIds.map((venueId, index) => ({
      rank: index + 1,
      venueId,
      name: byId.get(venueId)?.name ?? names.get(venueId) ?? null,
      option: byId.get(venueId) ?? null,
    })),
    detailsAvailable: catalogue.detailsAvailable,
    availabilityChecked,
    filtersNotChecked: catalogue.filtersNotChecked,
  };
};

const SUGGESTION_ERRORS = new Set([
  "EVENT_NOT_FOUND",
  "VENUE_SUGGESTION_NOT_ALLOWED_IN_STATUS",
  "VENUE_NOT_SELECTABLE",
  "VENUE_CAPACITY_TOO_SMALL",
  "VENUE_SUGGESTION_VERSION_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
]);

// One transaction in suggest_event_venue: suggestion, activity_log entry and the
// organiser's notification commit together or not at all.
const suggestEventVenue = async ({ actorId, eventId, venueId, expectedVersion, idempotencyKey }) => {
  const { data, error } = await supabase.rpc("suggest_event_venue", {
    p_actor_id: actorId,
    p_event_id: eventId,
    p_venue_id: venueId,
    p_expected_version: expectedVersion,
    p_idempotency_key: idempotencyKey,
    p_request_hash: hashRequest({ venueId }, {}, [eventId, expectedVersion]),
  });
  if (error) {
    if (SUGGESTION_ERRORS.has(error.message)) throw venueError(error.message);
    throw error;
  }
  if (!data || !data.suggestion) throw new Error("suggest_event_venue returned no suggestion.");
  return data.suggestion;
};

// Photos of a venue coordinators and Leads can choose: only
// available venues (Master 6.2). Venue Staff use the gallery routes (T28).
const requireSelectableVenue = async (venueId) => {
  const { data, error } = await supabase
    .from("venue")
    .select("venue_id")
    .eq("venue_id", venueId)
    .eq("is_active", true)
    .eq("status", VENUE_STATUS.ACTIVE)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw venueError("VENUE_NOT_FOUND");
};

const listSelectableVenuePhotos = async (venueId) => {
  await requireSelectableVenue(venueId);
  return { photos: await callPhotos(() => venuePhotoModel.listPhotos(venueId)) };
};

const getSelectableVenuePhotoImage = async (venueId, photoId) => {
  await requireSelectableVenue(venueId);
  const image = await callPhotos(() => venuePhotoModel.getPhotoImage(venueId, photoId));
  if (!image) throw venueError("PHOTO_NOT_FOUND");
  return image;
};

// ---------- venue booking review (SPM-181) ----------

const BOOKING_VENUE_SELECT =
  "room:room!inner(room_id,layout_type,capacity,venue:venue!inner(venue_id,name,address,max_capacity,operating_hours,setup_turnaround_min))";
const BOOKING_FIELDS =
  "booking_id,label,status,start_datetime,end_datetime,expected_attendance,layout_type,required_facilities,accessibility_requirements,special_requirements,rejection_reason,created_at,updated_at,event_id";
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
  // The booking reference is venue_booking.booking_id itself.
  bookingId: row.booking_id,
  label: row.label,
  status: row.status,
  statusLabel: VENUE_BOOKING_STATUS_LABELS[row.status] || row.status,
  venueId: row.room.venue.venue_id,
  venueName: row.room.venue.name,
  startDatetime: row.start_datetime,
  endDatetime: row.end_datetime,
  expectedAttendance: row.expected_attendance,
  submittedAt: row.created_at,
  updatedAt: row.updated_at,
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

const REQUEST_ID_SEARCH = /^REQ-?0*([1-9]\d{0,9})$/i;
const BOOKING_ID_SEARCH = /^#?0*([1-9]\d{0,9})$/;
const SEARCH_MATCH_LIMIT = 500;
const MAX_ID = 2147483647;

// The or() filter for a My Requests search: booking ID ("110" or "#110"),
// request reference ("REQ-000442"), booking label, event title or venue name.
// Titles and venue names live in other tables, so they are matched first and
// added as ID lists. Returns null when nothing can match.
const bookingSearchFilter = async (text) => {
  const parts = [`label.ilike.${quotedLike(text)}`];
  const bookingId = Number(BOOKING_ID_SEARCH.exec(text)?.[1]);
  if (bookingId && bookingId <= MAX_ID) parts.push(`booking_id.eq.${bookingId}`);
  const requestEventId = Number(REQUEST_ID_SEARCH.exec(text)?.[1]);
  if (requestEventId && requestEventId <= MAX_ID) parts.push(`event_id.eq.${requestEventId}`);

  const [events, venues] = await Promise.all([
    supabase.from("event").select("event_id").ilike("title", likePattern(text)).limit(SEARCH_MATCH_LIMIT),
    supabase.from("venue").select("venue_id,rooms:room(room_id)").ilike("name", likePattern(text)).limit(SEARCH_MATCH_LIMIT),
  ]);
  if (events.error) throw events.error;
  if (venues.error) throw venues.error;
  const eventIds = (events.data || []).map((event) => event.event_id);
  const roomIds = (venues.data || []).flatMap((venue) => (venue.rooms || []).map((room) => room.room_id));
  if (eventIds.length) parts.push(`event_id.in.(${eventIds.join(",")})`);
  if (roomIds.length) parts.push(`room_id.in.(${roomIds.join(",")})`);
  return parts.join(",");
};

// My Requests sorts (SPM-181). booking_status is an enum declared PENDING,
// APPROVED, REJECTED, CANCELLED, so ordering by status puts pending requests
// first. Ties fall back to the booking time, then the booking ID.
const BOOKING_SORT_COLUMNS = Object.freeze({
  date: "start_datetime",
  attendance: "expected_attendance",
  lastEdited: "updated_at",
  alphabetical: "event(title)",
});

const applyBookingSort = (query, sort, order) => {
  const ascending = order !== "desc";
  const sorted = sort === "default" || !BOOKING_SORT_COLUMNS[sort]
    ? query.order("status", { ascending: true }).order("start_datetime", { ascending })
    : query.order(BOOKING_SORT_COLUMNS[sort], { ascending, nullsFirst: false }).order("start_datetime", { ascending: true });
  return sorted.order("booking_id", { ascending: true });
};

const findVenueBookings = async ({ status, venueId, eventId, from, to, limit, q = null, sort = "default", order = "asc" }) => {
  let query = supabase.from("venue_booking").select(BOOKING_LIST_SELECT);
  if (status) query = query.eq("status", status);
  if (venueId) query = query.eq("room.venue_id", venueId);
  if (eventId) query = query.eq("event_id", eventId);
  // Half-open overlap with the requested day(s) (Master section 5.4).
  if (from && to) query = query.lt("start_datetime", to).gt("end_datetime", from);
  if (q) query = query.or(await bookingSearchFilter(q));
  query = applyBookingSort(query, sort, order).limit(limit + 1);

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
      .map(({ bookingId: id, label, status, statusLabel, venueId, venueName, startDatetime, endDatetime }) => ({
        bookingId: id,
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
  listVenueOptions,
  findManagedVenueRow,
  getManagedVenue,
  createVenue,
  updateVenue,
  setVenueStatus,
  getManagedVenueDetails,
  updateVenueDetails,
  listVenuePhotos,
  getVenuePhotoImage,
  addVenuePhoto,
  updateVenuePhoto,
  replaceVenuePhotoImage,
  deleteVenuePhoto,
  getVenueAvailability,
  getEventVenueOptions,
  suggestEventVenue,
  listSelectableVenuePhotos,
  getSelectableVenuePhotoImage,
  venueRequirements,
  toOptionAvailability,
  compareOptions,
  findVenueBookings,
  findEventBookings,
  findVenueBooking,
};
