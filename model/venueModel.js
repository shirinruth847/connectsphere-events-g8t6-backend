const crypto = require("node:crypto");
const supabase = require("../config/supabase");
const { getVenueLockPool } = require("../config/venueLockDatabase");
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
// Each filter is one value or a list, and a venue matches a list when it has
// any of its values (developer decision of 26 October 2026); every filter
// used must match.
const asList = (value) => (value === undefined ? [] : [].concat(value));
const matchesAny = (have, wanted) => !wanted.length || wanted.some((text) => includesText(have, text));
const matchesDetailFilters = (row, details, { layout, facility, accessibility }, detailsRead) => {
  const layouts = [...(details?.supportedLayouts || []), ...(row.rooms || []).map((room) => room.layout_type)];
  if (!matchesAny(layouts, asList(layout))) return false;
  if (detailsRead && !matchesAny(details?.facilities, asList(facility))) return false;
  const accessibilityList = details?.accessibilityFeatures ?? (row.accessibility_features ? [row.accessibility_features] : []);
  if (!matchesAny(accessibilityList, asList(accessibility))) return false;
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
const normalise = (text) => String(text).toLowerCase().replace(/theatre/g, "theater").replace(/[^a-z0-9]+/g, " ").trim();

// Explicit equivalent labels; shared words alone do not establish a capability.
const CAPABILITY_ALIASES = new Map([
  ["wheelchair accessible entrance", "wheelchair access"],
  ["wheelchair accessible", "wheelchair access"],
  ["wheelchair barrier free access", "wheelchair access"],
]);
const capability = (text) => {
  const label = normalise(text);
  return CAPABILITY_ALIASES.get(label) ?? label;
};

const listMeets = (list, need) => {
  const wanted = capability(need);
  return Boolean(wanted) && (list || []).some((item) => capability(item) === wanted);
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

  return {
    event: toBookingEvent(event),
    // SPM-195: an affected booking shows its block and the restore action (AC9).
    bookings: await attachBookingIncidents(eventId, bookings.map(toBookingDetail), INCIDENT_AUDIENCE.VENUE_STAFF),
  };
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

// ---------- venue booking requests (SPM-179) ----------

// Business refusals raised by begin_venue_booking_request and
// request_venue_bookings. Per-booking ones carry a JSON DETAIL (index, venueId
// and, for conflicts, the conflicting periods) so the form shows them inline.
const BOOKING_REQUEST_ERRORS = new Set([
  "EVENT_NOT_FOUND",
  "FORBIDDEN",
  "EVENT_NOT_IN_PLANNING",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "INVALID_VENUE_BOOKING_REQUEST",
  "VENUE_LISTED_TWICE",
  "VENUE_NOT_BOOKABLE",
  "BOOKING_IN_PAST",
  "BOOKING_OUTSIDE_EVENT",
  "VENUE_CAPACITY_EXCEEDED",
  "VENUE_ALREADY_BOOKED_FOR_EVENT",
  "VENUE_BUFFERS_NOT_SET",
  "BOOKING_CONFLICT",
  "PRIMARY_VENUE_REQUIRED",
  "PRIMARY_VENUE_ALREADY_SET",
]);
// Another transaction holds a lock this one needs (lock_timeout), or PostgreSQL
// ended this one to break a deadlock or serialisation clash: the coordinator
// can send the request again (Master 7.4: a retryable 409).
const RETRYABLE_LOCK_CODES = new Set(["55P03", "40P01", "40001"]);
// The statement ran past statement_timeout, or the server ended the session
// (idle_in_transaction_session_timeout, shutdown). Nothing was saved.
const SESSION_ENDED_CODES = new Set(["57014", "25P03", "57P01", "57P02", "57P03"]);
const VENUE_LOCK_TIMEOUT = "5s";
// MongoDB is read while the venue lock is held, so a slow read must not hold it
// for long; a read that runs out answers AVAILABILITY_UNAVAILABLE.
const MONGO_READ_UNDER_LOCK_MS = 3000;

const parseErrorDetail = (detail) => {
  try {
    const parsed = detail ? JSON.parse(detail) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

// Failures every venue lock transaction maps the same way: a VenueError as it
// is, a lock clash as a retryable 409, an ended session as 503. Null otherwise.
const toLockFailure = (error) => {
  if (error?.name === "VenueError") return error;
  if (RETRYABLE_LOCK_CODES.has(error?.code)) return venueError("VENUE_LOCK_TIMEOUT");
  // Class 08 is a connection exception.
  if (SESSION_ENDED_CODES.has(error?.code) || String(error?.code ?? "").startsWith("08")) {
    return venueError("VENUE_BOOKINGS_UNAVAILABLE");
  }
  return null;
};

// A business refusal raised by a database function: P0001/P0002 with a known MESSAGE.
const isDatabaseRefusal = (error, knownMessages) =>
  (error?.code === "P0001" || error?.code === "P0002") && knownMessages.has(error.message);

const toBookingRequestError = (error) => {
  const lockFailure = toLockFailure(error);
  if (lockFailure) return lockFailure;
  if (isDatabaseRefusal(error, BOOKING_REQUEST_ERRORS)) {
    const { index, venueId, conflicts, capacity, expectedAttendance } = parseErrorDetail(error.detail);
    return venueError(error.message, { index, venueId, conflicts, capacity, expectedAttendance });
  }
  return error;
};

const toIsoOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// Advisory checks for one requested booking (Master 5.4): shown to the
// coordinator and Venue Staff, never a reason to refuse.
const bookingWarnings = (item, range, venue, document) => {
  const messages = [];
  const hours = venueConflictModel.operatingHoursWarning(range, venue.operatingHours);
  if (hours) messages.push(hours.message);
  const layouts = document?.supportedLayouts || [];
  if (layouts.length && !layouts.some((layout) => normalise(layout) === normalise(item.layout))) {
    messages.push(`${venue.name} does not list the ${item.layout} layout.`);
  }
  item.requiredFacilities
    .filter((facility) => !listMeets(document?.facilities, facility))
    .forEach((facility) => messages.push(`${venue.name} does not list the facility "${facility}".`));
  item.accessibilityNeeds
    .filter((need) => !listMeets(document?.accessibilityFeatures, need))
    .forEach((need) => messages.push(`${venue.name} does not list the accessibility feature "${need}".`));
  return messages;
};

// The MongoDB holds and blocks one booking's occupied range overlaps (Master
// 5.4). Normal booking requests must respect every active hold, including the
// event's own. Converting a hold is a separate workflow (SPM-188/SPM-283).
const findCalendarConflicts = (entries, { venueId, range, now }) =>
  entries
    .filter((entry) => entry.venueId === venueId)
    .filter((entry) => (entry.type === venueConflictModel.ENTRY_TYPES.BLOCK
      ? entry.status === "ACTIVE"
      : venueConflictModel.isHoldActive(entry, now)))
    .filter((entry) => venueConflictModel.overlaps(range, { start: entry.occupiedStart, end: entry.occupiedEnd }))
    .map((entry) => ({
      type: entry.type,
      occupiedStart: toIsoOrNull(entry.occupiedStart),
      occupiedEnd: toIsoOrNull(entry.occupiedEnd),
      ...(entry.type === venueConflictModel.ENTRY_TYPES.BLOCK
        ? { reasonLabel: venueConflictModel.BLOCK_REASON_LABELS[entry.reason] || entry.reason || null }
        : { holdExpiresAt: toIsoOrNull(entry.holdExpiresAt) }),
    }));

// Runs while begin_venue_booking_request holds the event and venue locks
// (Master 7.4 step 2): reads each venue's setup/turnaround minutes and its holds
// and blocks from MongoDB, refuses overlaps with active holds and blocks, and
// returns the minutes for the PostgreSQL booking-against-booking check.
const checkVenueCalendar = async (bookings, venues) => {
  const venueById = new Map(venues.map((venue) => [venue.venueId, venue]));
  const venueIds = [...venueById.keys()];
  const times = bookings.flatMap((item) => [Date.parse(item.start), Date.parse(item.end)]);
  const from = new Date(Math.min(...times) - BUFFER_MARGIN_MS);
  const to = new Date(Math.max(...times) + BUFFER_MARGIN_MS);

  let details;
  let entries;
  try {
    [details, entries] = await Promise.all([
      venueDetailModel.getVenueDetailsByIds(venueIds, { maxTimeMS: MONGO_READ_UNDER_LOCK_MS }),
      venueCalendarModel.findCalendarEntries(venueIds, from, to, { maxTimeMS: MONGO_READ_UNDER_LOCK_MS }),
    ]);
  } catch (error) {
    console.warn("[venue-booking-request] MongoDB unavailable", { code: error.code, name: error.name });
    throw venueError("AVAILABILITY_UNAVAILABLE");
  }

  const now = new Date();
  const minutes = {};
  const warnings = [];
  bookings.forEach((item, index) => {
    const venue = venueById.get(item.venueId);
    if (!venue || !venue.isActive || venue.status !== VENUE_STATUS.ACTIVE) {
      throw venueError("VENUE_NOT_BOOKABLE", { index, venueId: item.venueId });
    }
    const document = details.get(String(item.venueId));
    const setupMinutes = document?.setupMinutes;
    const turnaroundMinutes = document?.turnaroundMinutes;
    if (!Number.isInteger(setupMinutes) || !Number.isInteger(turnaroundMinutes)) {
      throw venueError("VENUE_BUFFERS_NOT_SET", { index, venueId: item.venueId });
    }
    minutes[item.venueId] = { setupMinutes, turnaroundMinutes };

    const range = venueConflictModel.occupiedRange(item.start, item.end, setupMinutes, turnaroundMinutes);
    const conflicts = findCalendarConflicts(entries, { venueId: item.venueId, range, now });
    if (conflicts.length) throw venueError("BOOKING_CONFLICT", { index, venueId: item.venueId, conflicts });

    const messages = bookingWarnings(item, range, venue, document);
    if (messages.length) warnings.push({ index, venueId: item.venueId, messages });
  });
  return { minutes, warnings };
};

const toBookingRequestResult = (result) => ({
  ...result,
  bookings: (result.bookings || []).map((item) => ({
    ...item,
    statusLabel: VENUE_BOOKING_STATUS_LABELS[item.status] || item.status,
  })),
});

// Undo steps run newest first. Failure is logged and surfaced as an uncertain
// calendar outcome, rather than claiming the original action changed nothing.
const undoMongoWrites = async (undoSteps) => {
  let complete = true;
  for (const undo of [...undoSteps].reverse()) {
    try {
      await undo();
    } catch (error) {
      complete = false;
      console.error("[venue-lock] could not undo a MongoDB write after rollback", { code: error?.code, name: error?.name });
    }
  }
  return complete;
};

// The jsonb result of one `SELECT public.fn(...) AS result` on the lock client.
const selectResult = async (client, sql, params) => (await client.query(sql, params)).rows[0].result;

// Runs work(client) in one transaction on one client of the venue lock
// connection (Master 7.4, T33), with a short lock_timeout. Commits only when
// work resolves; otherwise rolls back and rethrows. A client whose rollback
// fails, or whose connection was lost, is discarded, never returned to the pool.
// Every venue calendar writer (bookings here; holds and blocks in SPM-188 and
// SPM-195) takes the venue lock through this function.
const withVenueLockTransaction = async (work) => {
  let pool;
  try {
    pool = getVenueLockPool();
  } catch (error) {
    console.error("[venue-booking-request] venue lock connection unavailable", { code: error.code });
    throw venueError("VENUE_BOOKINGS_UNAVAILABLE");
  }

  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    console.error("[venue-booking-request] cannot open the venue lock connection", { code: error.code });
    throw venueError("VENUE_BOOKINGS_UNAVAILABLE");
  }

  // pg-pool removes its own error listener while a client is checked out, so a
  // connection lost between queries (for example during the MongoDB read)
  // would otherwise be an unhandled 'error' event that stops the process.
  let connectionLost = false;
  const onConnectionError = (error) => {
    connectionLost = true;
    console.error("[venue-booking-request] venue lock connection lost", { code: error.code });
  };
  client.on("error", onConnectionError);

  // MongoDB writes made under the lock register an undo (SPM-195). It runs when
  // PostgreSQL certainly did not commit: work failed, or the server refused the
  // COMMIT. A COMMIT lost with its connection may have landed, so nothing is
  // undone; a retry with the same Idempotency-Key replays or completes it.
  const undoSteps = [];
  const transaction = { onRollback: (undo) => undoSteps.push(undo) };
  let committing = false;

  let discardClient = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${VENUE_LOCK_TIMEOUT}'`);
    const result = await work(client, transaction);
    committing = true;
    await client.query("COMMIT");
    return result;
  } catch (error) {
    const serverRefusedCommit = /^[0-9A-Z]{5}$/.test(String(error?.code ?? "")) && !String(error.code).startsWith("08");
    const outcomeUnknown = committing && (connectionLost || !serverRefusedCommit);
    // Undo before releasing the venue lock whenever the transaction is still open.
    const recovered = outcomeUnknown || await undoMongoWrites(undoSteps);
    if (connectionLost) {
      discardClient = true;
    } else {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
      }
    }
    if (!recovered) throw venueError("VENUE_CALENDAR_OUTCOME_UNKNOWN");
    // PostgreSQL rolls back a transaction whose connection is gone. A COMMIT
    // that was in flight may still have landed, so the answer is "try again":
    // the same Idempotency-Key then replays a saved request.
    if (connectionLost && error?.name !== "VenueError") throw venueError("VENUE_BOOKINGS_UNAVAILABLE");
    throw error;
  } finally {
    client.removeListener("error", onConnectionError);
    client.release(discardClient);
  }
};

// Lock the event then the venues, check MongoDB holds and blocks under those
// locks, then save the bookings, version, activity and notice, all in one
// venue lock transaction (Master 7, 7.4). Nothing is announced before COMMIT;
// any failure rolls everything back.
const requestVenueBookings = async ({ actorId, eventId, bookings, idempotencyKey }) => {
  const requestHash = hashRequest({ bookings }, {}, [eventId]);
  const venueIds = [...new Set(bookings.map((item) => item.venueId))].sort((left, right) => left - right);

  try {
    const result = await withVenueLockTransaction(async (client) => {
      const started = await selectResult(client,
        "SELECT public.begin_venue_booking_request($1, $2, $3::integer[], $4, $5) AS result",
        [actorId, eventId, venueIds, idempotencyKey, requestHash]
      );
      if (started.replay) return started.replay;

      const { minutes, warnings } = await checkVenueCalendar(bookings, started.venues || []);
      return selectResult(client,
        "SELECT public.request_venue_bookings($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7) AS result",
        [actorId, eventId, JSON.stringify(bookings), JSON.stringify(minutes), JSON.stringify(warnings), idempotencyKey, requestHash]
      );
    });
    return toBookingRequestResult(result);
  } catch (error) {
    throw toBookingRequestError(error);
  }
};

const EVENT_BOOKING_SELECT =
  "booking_id,venue_id,label,status,start_datetime,end_datetime,expected_attendance,layout_type,required_facilities,accessibility_requirements,special_requirements,rejection_reason,is_primary,occupied_range,created_at,venue:venue!venue_booking_venue_id_fkey(name)";

// PostgREST returns a tstzrange as text, for example
// ["2030-01-01 09:30:00+00","2030-01-01 12:45:00+00").
const RANGE_PATTERN = /^[[(]"?([^",]*)"?,"?([^",]*)"?[)\]]$/;
const rangeBoundToIso = (text) => {
  if (!text) return null;
  const normalised = text.trim().replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return toIsoOrNull(normalised);
};
const parseOccupiedRange = (text) => {
  const match = RANGE_PATTERN.exec(typeof text === "string" ? text.trim() : "");
  return match
    ? { occupiedStart: rangeBoundToIso(match[1]), occupiedEnd: rangeBoundToIso(match[2]) }
    : { occupiedStart: null, occupiedEnd: null };
};

const toEventVenueBooking = (row) => ({
  bookingId: row.booking_id,
  venueId: row.venue_id,
  venueName: row.venue?.name ?? null,
  label: row.label,
  status: row.status,
  statusLabel: VENUE_BOOKING_STATUS_LABELS[row.status] || row.status,
  isPrimary: row.is_primary,
  start: row.start_datetime,
  end: row.end_datetime,
  ...parseOccupiedRange(row.occupied_range),
  expectedAttendance: row.expected_attendance,
  layout: row.layout_type,
  requiredFacilities: row.required_facilities || [],
  accessibilityNeeds: row.accessibility_requirements || [],
  specialRequirements: row.special_requirements,
  rejectionReason: row.rejection_reason,
  requestedAt: row.created_at,
});

// Every booking of one event, for its assigned coordinator and supervising Lead
// (requireVisibleEvent has already checked the relationship).
const listEventVenueBookings = async (eventId) => {
  const { data, error } = await supabase
    .from("venue_booking")
    .select(EVENT_BOOKING_SELECT)
    .eq("event_id", eventId)
    .order("start_datetime", { ascending: true })
    .order("booking_id", { ascending: true });
  if (error) throw error;
  const bookings = (data || []).map(toEventVenueBooking);
  // The primary venue as _event_primary_venue reads it: a booking written
  // outside the request flow carries no flag, but as the event's only active
  // booking it is the primary venue (Master 5.4.2). Showing the stored flag
  // alone would make the form send a second primary, which is refused.
  const active = bookings.filter((booking) => ACTIVE_BOOKING_STATUSES.includes(booking.status));
  if (active.length === 1 && !active[0].isPrimary) active[0].isPrimary = true;
  return attachBookingIncidents(eventId, bookings, INCIDENT_AUDIENCE.COORDINATOR);
};

// ---------- operational blocks and restoration (SPM-195) ----------

// Business refusals raised by the SPM-195 database functions.
const VENUE_BLOCK_ERRORS = new Set([
  "FORBIDDEN",
  "VENUE_NOT_FOUND",
  "INVALID_VENUE_BLOCK",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "AFFECTED_SET_CHANGED",
  "INCIDENT_NOT_FOUND",
  "INCIDENT_NOT_RESTORABLE",
  "VENUE_OUT_OF_SERVICE",
]);
// Operations that start from a venue lock the affected events first (Master 7).
// When the set grows between the first read and the locks, the transaction is
// rolled back and run again with the larger set, a bounded number of times.
const MAX_LOCK_ATTEMPTS = 3;

const INCIDENT_AUDIENCE = Object.freeze({ COORDINATOR: "COORDINATOR", VENUE_STAFF: "VENUE_STAFF" });
const INCIDENT_STATUS_LABELS = Object.freeze({ OPEN: "Open", RESOLVED: "Resolved" });
const INCIDENT_RESOLUTION_LABELS = Object.freeze({
  RESTORED: "Booking restored",
  REPLACED: "Venue replaced",
  RELEASED: "Booking released",
  EVENT_CANCELLED: "Event cancelled",
});
const BLOCK_STATUS_LABELS = Object.freeze({ ACTIVE: "Active", LIFTED: "Lifted" });
// Whether an open incident's booking can be restored now, per audience (AC7, AC9).
// "ended": the booking or hold no longer reserves the venue (an expired hold,
// before the expiry job closes its incident), so it can never be restored.
const RESTORE_LABELS = Object.freeze({
  [INCIDENT_AUDIENCE.VENUE_STAFF]: {
    true: "Can be restored",
    false: "Venue still blocked",
    null: "Availability not checked",
    ended: "Booking or hold has ended",
  },
  [INCIDENT_AUDIENCE.COORDINATOR]: {
    true: "The venue is free again. Waiting for Venue Staff to restore the booking.",
    false: "Waiting for the venue to become free.",
    null: "Availability not checked.",
    ended: "The booking or hold has ended, so it cannot be restored.",
  },
});
const ACTIVE_HOLD_OR_BOOKING = new Set(ACTIVE_BOOKING_STATUSES);

// Backend labels; an unknown code is shown as itself.
const blockReasonLabel = (reason) => venueConflictModel.BLOCK_REASON_LABELS[reason] || reason;
const incidentStatusLabel = (status) => INCIDENT_STATUS_LABELS[status] || status;
const incidentResolutionLabel = (resolution) => (resolution ? INCIDENT_RESOLUTION_LABELS[resolution] || resolution : null);

const toVenueBlockError = (error) => {
  const lockFailure = toLockFailure(error);
  if (lockFailure) return lockFailure;
  return isDatabaseRefusal(error, VENUE_BLOCK_ERRORS) ? venueError(error.message) : error;
};

// Every MongoDB read or write in a block flow: when MongoDB fails, nothing is
// saved in either store (Master 7.4 step 6, AC11).
const calendarCall = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    if (error?.name === "VenueError") throw error;
    console.warn("[venue-block] MongoDB unavailable", { code: error?.code, name: error?.name });
    throw venueError("VENUE_CALENDAR_UNAVAILABLE");
  }
};

// Acknowledgement can be lost after persistence. Read the attempt's private
// ownership token on the primary before deciding the PostgreSQL outcome.
const writeCalendarBlock = async (identity, write) => {
  try {
    return await write();
  } catch (error) {
    try {
      if (await venueCalendarModel.ownsBlockWrite(identity)) {
        const saved = await venueCalendarModel.findCalendarEntry(identity.blockId, { readPreference: "primary", maxTimeMS: MONGO_READ_UNDER_LOCK_MS });
        if (saved) return saved;
      }
    } catch {
      // The registered, token-guarded undo still runs. If that also fails, the
      // caller receives OUTCOME_UNKNOWN rather than a false no-change claim.
    }
    throw venueError("VENUE_CALENDAR_UNAVAILABLE");
  }
};

const sortedIds = (ids) => [...new Set(ids.filter(Number.isInteger))].sort((left, right) => left - right);

// The block's MongoDB ID comes from the actor and Idempotency-Key, so a retry
// after a commit that failed past the MongoDB write finds the same document.
const blockIdFor = (actorId, idempotencyKey) =>
  crypto.createHash("sha256").update(`venue-block:${actorId}:${idempotencyKey}`).digest("hex").slice(0, 24);

const sameBlock = (entry, venueId, block) =>
  entry.venueId === venueId && entry.type === venueConflictModel.ENTRY_TYPES.BLOCK
  && new Date(entry.start).getTime() === Date.parse(block.start)
  && new Date(entry.end).getTime() === Date.parse(block.end)
  && entry.reason === block.reason && entry.note === block.note;

const toBlock = (entry) => ({
  blockId: entry.id,
  venueId: entry.venueId,
  reason: entry.reason,
  reasonLabel: blockReasonLabel(entry.reason),
  start: toIsoOrNull(entry.start),
  end: toIsoOrNull(entry.end),
  note: entry.note,
  status: entry.status,
  statusLabel: BLOCK_STATUS_LABELS[entry.status] || entry.status,
  version: entry.version,
  createdAt: toIsoOrNull(entry.createdAt),
  updatedAt: toIsoOrNull(entry.updatedAt),
});

// Setup/turnaround minutes, for booking rows written before occupied_range
// existed. They are set once and never change (Master 5.4.1).
const readVenueMinutes = async (venueId) => {
  const details = await venueDetailModel.getVenueDetailsByIds([venueId], { maxTimeMS: MONGO_READ_UNDER_LOCK_MS });
  const document = details.get(String(venueId));
  return {
    setup: Number.isInteger(document?.setupMinutes) ? document.setupMinutes : null,
    turnaround: Number.isInteger(document?.turnaroundMinutes) ? document.turnaroundMinutes : null,
  };
};

// Events whose active bookings at the venue are near the block, read before any
// lock. A superset is harmless: the extra events are locked and left unchanged.
const findBookingEventIdsNear = async (venueId, start, end) => {
  const { data, error } = await supabase
    .from("venue_booking")
    .select("event_id")
    .eq("venue_id", venueId)
    .in("status", ACTIVE_BOOKING_STATUSES)
    .lt("start_datetime", new Date(Date.parse(end) + BUFFER_MARGIN_MS).toISOString())
    .gt("end_datetime", new Date(Date.parse(start) - BUFFER_MARGIN_MS).toISOString());
  if (error) throw error;
  return (data || []).map((row) => row.event_id);
};

// Every event the block may affect, read before any lock: bookings near it and
// active holds under it. The locks re-check the set (requireLocked).
const findEventIdsNearBlock = async (range) => {
  const holds = await calendarCall(() => venueCalendarModel.findCalendarEntries([range.venueId], range.start, range.end));
  return [
    ...(await findBookingEventIdsNear(range.venueId, range.start, range.end)),
    ...venueConflictModel.findHoldsUnderBlock(holds, range, new Date()).map((hold) => hold.eventId),
  ];
};

const findOpenIncidentEventIds = async (blockId) => {
  const { data, error } = await supabase
    .from("resource_incidents")
    .select("event_id")
    .eq("calendar_block_id", blockId)
    .eq("type", "VENUE_BLOCK")
    .eq("status", "OPEN");
  if (error) throw error;
  return (data || []).map((row) => row.event_id);
};

// Runs work(client, lockedEventIds) on the venue lock connection. work throws
// AFFECTED_SET_CHANGED with the events it found unlocked; the next attempt
// locks them too.
const withAffectedEventLocks = async (eventIds, work) => {
  let locked = sortedIds(eventIds);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await withVenueLockTransaction((client, transaction) => work(client, locked, transaction));
    } catch (error) {
      const failure = toVenueBlockError(error);
      if (failure.code !== "AFFECTED_SET_CHANGED") throw failure;
      if (attempt >= MAX_LOCK_ATTEMPTS) throw venueError("VENUE_LOCK_TIMEOUT");
      locked = sortedIds([...locked, ...(failure.eventIds || [])]);
    }
  }
};

const requireLocked = (needed, locked) => {
  const missing = sortedIds(needed).filter((eventId) => !locked.includes(eventId));
  if (missing.length) throw venueError("AFFECTED_SET_CHANGED", { eventIds: missing });
};

// POST /api/venues/:venueId/blocks (AC2–AC5, AC11–AC14). Reads the affected
// events, locks them and then the venue, re-reads the MongoDB holds under the
// lock, writes the incidents, versions, supersession, history and notices, then
// the BLOCK document; commits only when the MongoDB write succeeded.
const createVenueBlock = async ({ actorId, venueId, block, idempotencyKey }) => {
  const requestHash = hashRequest(block, {}, [venueId]);
  const blockId = blockIdFor(actorId, idempotencyKey);
  const range = { venueId, start: block.start, end: block.end };

  const minutes = await calendarCall(() => readVenueMinutes(venueId));
  const eventIds = await findEventIdsNearBlock(range);

  const result = await withAffectedEventLocks(eventIds, async (client, locked, transaction) => {
    const started = await selectResult(client,
      "SELECT public.begin_venue_block($1, $2, $3, $4, $5, $6, $7::integer[], $8, $9) AS result",
      [actorId, venueId, block.start, block.end, minutes.setup, minutes.turnaround, locked, idempotencyKey, requestHash]
    );
    if (started.replay) return started.replay;

    const entries = await calendarCall(() => venueCalendarModel.findCalendarEntries(
      [venueId], block.start, block.end, { maxTimeMS: MONGO_READ_UNDER_LOCK_MS }
    ));
    const holds = venueConflictModel.findHoldsUnderBlock(entries, range, new Date());
    requireLocked([...started.affectedEventIds, ...holds.map((hold) => hold.eventId)], locked);

    const recorded = await selectResult(client,
      "SELECT public.record_venue_block($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::integer[], $8, $9) AS result",
      [
        actorId, venueId, JSON.stringify({ blockId, ...block }),
        JSON.stringify(holds.map((hold) => ({ holdId: hold.id, eventId: hold.eventId }))),
        minutes.setup, minutes.turnaround, locked, idempotencyKey, requestHash,
      ]
    );

    const writeToken = crypto.randomUUID();
    // Register before sending the write: a network error can follow persistence.
    // The token prevents compensation from deleting an earlier attempt's block.
    transaction.onRollback(() => venueCalendarModel.deleteBlock({ blockId, venueId, writeToken }));
    const written = await writeCalendarBlock(
      { blockId, venueId, writeToken },
      () => venueCalendarModel.insertBlock({ blockId, venueId, ...block, createdBy: actorId, writeToken })
    );
    if (written.existing && !sameBlock(written, venueId, block)) throw venueError("IDEMPOTENCY_KEY_REUSED");
    return recorded;
  });

  return {
    ...result,
    block: {
      ...result.block,
      reasonLabel: blockReasonLabel(result.block.reason),
      statusLabel: BLOCK_STATUS_LABELS.ACTIVE,
      version: 1,
    },
    incidents: (result.incidents || []).map((incident) => ({ ...incident, requestId: formatRequestId(incident.eventId) })),
  };
};

const INCIDENT_SELECT =
  "incident_id,event_id,booking_id,calendar_hold_id,calendar_block_id,status,resolution,created_at,resolved_at,"
  + "booking:venue_booking(venue_id,status,start_datetime,end_datetime,occupied_range),event:event(title)";

const findIncidents = async (filter) => {
  let query = supabase.from("resource_incidents").select(INCIDENT_SELECT).eq("type", "VENUE_BLOCK");
  if (filter.eventId) query = query.eq("event_id", filter.eventId);
  if (filter.blockIds) query = query.in("calendar_block_id", filter.blockIds);
  if (filter.incidentIds) query = query.in("incident_id", filter.incidentIds);
  const { data, error } = await query.order("created_at", { ascending: false }).order("incident_id", { ascending: false });
  if (error) throw error;
  return data || [];
};

// Each incident with its event reference, its block and, while open, whether
// its whole occupied range is free of active blocks now (AC7, AC9). MongoDB is
// read for holds, blocks and older bookings' minutes; when it cannot be read,
// the block is null and canBeRestored is null, never true.
const describeIncidents = async (rows, audience) => {
  if (!rows.length) return [];
  const now = new Date();
  const calendarIds = rows.flatMap((row) => [row.calendar_block_id, row.calendar_hold_id]).filter(Boolean);
  const venueIds = [...new Set(rows.map((row) => row.booking?.venue_id).filter(Number.isInteger))];

  let entriesById = null;
  let minutesByVenue = null;
  try {
    [entriesById, minutesByVenue] = await Promise.all([
      venueCalendarModel.findEntriesByIds(calendarIds),
      venueDetailModel.getVenueDetailsByIds(venueIds),
    ]);
  } catch (error) {
    console.warn("[venue-block] MongoDB unavailable for incidents", { code: error?.code, name: error?.name });
  }

  const located = rows.map((row) => {
    const hold = row.calendar_hold_id ? entriesById?.get(row.calendar_hold_id) : null;
    const venueId = row.booking?.venue_id ?? hold?.venueId ?? null;
    let range = null;
    if (row.booking) {
      const stored = parseOccupiedRange(row.booking.occupied_range);
      if (stored.occupiedStart) range = { start: stored.occupiedStart, end: stored.occupiedEnd };
      else if (minutesByVenue) {
        const document = minutesByVenue.get(String(venueId));
        const occupied = venueConflictModel.occupiedRange(
          row.booking.start_datetime, row.booking.end_datetime, document?.setupMinutes, document?.turnaroundMinutes
        );
        range = { start: occupied.start.toISOString(), end: occupied.end.toISOString() };
      }
    } else if (hold) {
      range = { start: toIsoOrNull(hold.occupiedStart), end: toIsoOrNull(hold.occupiedEnd) };
    }
    // A booking that is no longer active, or a hold that is expired, converted
    // or gone, cannot be restored whatever the calendar says.
    const ended = row.booking
      ? !ACTIVE_HOLD_OR_BOOKING.has(row.booking.status)
      : Boolean(row.calendar_hold_id && entriesById && !(hold && venueConflictModel.isHoldActive(hold, now)));
    return { row, venueId, range, ended };
  });

  const open = located.filter((item) => item.row.status === "OPEN" && !item.ended && item.venueId && item.range);
  let calendarEntries = null;
  if (open.length && entriesById) {
    try {
      const from = new Date(Math.min(...open.map((item) => Date.parse(item.range.start))));
      const to = new Date(Math.max(...open.map((item) => Date.parse(item.range.end))));
      calendarEntries = await venueCalendarModel.findCalendarEntries([...new Set(open.map((item) => item.venueId))], from, to);
    } catch (error) {
      console.warn("[venue-block] MongoDB unavailable for restorability", { code: error?.code, name: error?.name });
    }
  }

  return located.map(({ row, venueId, range, ended }) => {
    const block = entriesById?.get(row.calendar_block_id) || null;
    let restorable = null;
    if (row.status === "OPEN" && ended) restorable = false;
    else if (row.status === "OPEN" && calendarEntries) {
      restorable = venueConflictModel.canBeRestored(range, calendarEntries.filter((entry) => entry.venueId === venueId));
    }
    return {
      incidentId: row.incident_id,
      eventId: row.event_id,
      requestId: formatRequestId(row.event_id),
      eventTitle: row.event?.title ?? null,
      bookingId: row.booking_id,
      calendarHoldId: row.calendar_hold_id,
      calendarBlockId: row.calendar_block_id,
      venueId,
      occupiedStart: range?.start ?? null,
      occupiedEnd: range?.end ?? null,
      status: row.status,
      statusLabel: incidentStatusLabel(row.status),
      resolution: row.resolution,
      resolutionLabel: incidentResolutionLabel(row.resolution),
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      block: block ? toBlock(block) : null,
      canBeRestored: row.status === "OPEN" ? restorable : null,
      restoreLabel: row.status === "OPEN" ? RESTORE_LABELS[audience][ended ? "ended" : String(restorable)] : null,
    };
  });
};

// The coordinator's options on an affected booking (Master 5.4.4, AC7).
const coordinatorIncidentActions = (incident) => [
  { action: "RESTORE", available: false, label: incident.restoreLabel },
  { action: "REPLACE", available: false, label: "Replacing the venue is not available yet." },
  { action: "CANCEL", available: true, label: "Cancel the event." },
];

// Adds each booking's incident: the open one, otherwise the latest resolved one.
const attachBookingIncidents = async (eventId, bookings, audience) => {
  if (!bookings.length) return bookings;
  const incidents = (await describeIncidents(await findIncidents({ eventId }), audience))
    .filter((incident) => incident.bookingId != null);
  return bookings.map((booking) => {
    const own = incidents.filter((incident) => incident.bookingId === booking.bookingId);
    const incident = own.find((item) => item.status === "OPEN") || own[0] || null;
    if (!incident) return { ...booking, incident: null };
    const card = audience === INCIDENT_AUDIENCE.COORDINATOR && incident.status === "OPEN"
      ? { ...incident, actions: coordinatorIncidentActions(incident) }
      : incident;
    return { ...booking, incident: card };
  });
};

// The incidents of the given blocks, as Venue Staff see them.
const describeBlockIncidents = async (blockIds) =>
  describeIncidents(await findIncidents({ blockIds }), INCIDENT_AUDIENCE.VENUE_STAFF);

// GET /api/venues/:venueId/blocks: the venue's current and upcoming blocks,
// lifted ones included, each with its incidents (Venue Staff venue page, AC9).
const listVenueBlocks = async (venueId) => {
  const venue = await findManagedVenueRow(venueId);
  if (!venue) throw venueError("VENUE_NOT_FOUND");
  const { blocks, hasMore } = await calendarCall(() => venueCalendarModel.findVenueBlocks(venueId, new Date()));
  const incidents = blocks.length ? await describeBlockIncidents(blocks.map((block) => block.id)) : [];
  return {
    venueId,
    venueName: venue.name,
    hasMore,
    blocks: blocks.map((block) => ({
      ...toBlock(block),
      incidents: incidents.filter((incident) => incident.calendarBlockId === block.id),
    })),
  };
};

// PUT /api/venues/:venueId/blocks/:blockId (shorten) and POST .../lift (AC9,
// AC11, AC14). A repeated request that matches the block's current state
// changes nothing and returns 200. Open incidents stay open: Venue Staff then
// restore each booking that is free again (AC10).
const changeVenueBlock = async ({ actorId, venueId, blockId, change = null, lift = null }) => {
  const current = await calendarCall(() => venueCalendarModel.findCalendarEntry(blockId));
  if (!current || current.type !== venueConflictModel.ENTRY_TYPES.BLOCK || current.venueId !== venueId) {
    throw venueError("BLOCK_NOT_FOUND");
  }

  const unchanged = async () => ({
    block: toBlock(current),
    incidents: await describeBlockIncidents([blockId]),
    changed: false,
  });
  if (lift && current.status === "LIFTED") return unchanged();
  if (current.status !== "ACTIVE") throw venueError("BLOCK_NOT_ACTIVE");
  if (change) {
    const kind = venueConflictModel.classifyBlockChange(current, change);
    if (kind === venueConflictModel.BLOCK_CHANGE.UNCHANGED) return unchanged();
    if (kind === venueConflictModel.BLOCK_CHANGE.EXTEND) throw venueError("BLOCK_CANNOT_BE_EXTENDED");
  }
  const expectedVersion = (lift || change).version;
  if (current.version !== expectedVersion) throw venueError("BLOCK_VERSION_CONFLICT");

  const action = lift ? "LIFTED" : "SHORTENED";
  const before = { start: toIsoOrNull(current.start), end: toIsoOrNull(current.end) };
  const after = lift ? before : { start: change.start, end: change.end };
  const minutes = await calendarCall(() => readVenueMinutes(venueId));

  const updated = await withAffectedEventLocks(await findOpenIncidentEventIds(blockId), async (client, locked, transaction) => {
    const started = await selectResult(client,
      "SELECT public.begin_venue_block_change($1, $2, $3, $4::integer[]) AS result",
      [actorId, venueId, blockId, locked]
    );
    requireLocked(started.affectedEventIds, locked);

    const latest = await calendarCall(() => venueCalendarModel.findCalendarEntry(blockId, { maxTimeMS: MONGO_READ_UNDER_LOCK_MS }));
    if (!latest || latest.status !== "ACTIVE" || latest.version !== expectedVersion) throw venueError("BLOCK_VERSION_CONFLICT");

    await client.query(
      "SELECT public.record_venue_block_change($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::integer[]) AS result",
      [actorId, venueId, blockId, action, JSON.stringify(before), JSON.stringify(after), minutes.setup, minutes.turnaround, locked]
    );
    const writeToken = crypto.randomUUID();
    transaction.onRollback(() => venueCalendarModel.revertBlock({
      blockId, venueId, version: expectedVersion + 1, start: latest.start, end: latest.end, writeToken,
    }));
    const written = await writeCalendarBlock(
      { blockId, venueId, writeToken },
      () => venueCalendarModel.updateBlock({
        blockId, venueId, expectedVersion, start: after.start, end: after.end, lift: Boolean(lift), writeToken,
      })
    );
    if (!written) throw venueError("BLOCK_VERSION_CONFLICT");
    return written;
  });

  return {
    block: toBlock(updated),
    incidents: await describeBlockIncidents([blockId]),
    changed: true,
  };
};

// POST /api/venues/incidents/:incidentId/restore (AC10, AC13, Master 7.1
// booking restoration). Locks the incident's event, then the venue; restores
// only when no active block overlaps the whole occupied range under the lock.
// The incident's venue, read before any lock: the booking's, or the hold's in MongoDB.
const findIncidentVenueId = async (row) => {
  if (!row.calendar_hold_id) return row.booking?.venue_id ?? null;
  const hold = await calendarCall(() => venueCalendarModel.findCalendarEntry(row.calendar_hold_id));
  if (!hold?.venueId) throw venueError("INCIDENT_NOT_RESTORABLE");
  return hold.venueId;
};

// Under the lock: the occupied range and start to restore. A hold is re-read
// and must still be active at this venue; a booking's come from PostgreSQL.
const readRestoreTarget = async (incident, venueId) => {
  if (!incident.calendarHoldId) {
    return { range: { start: incident.occupiedStart, end: incident.occupiedEnd }, start: incident.start };
  }
  const hold = await calendarCall(() => venueCalendarModel.findCalendarEntry(
    incident.calendarHoldId, { maxTimeMS: MONGO_READ_UNDER_LOCK_MS }
  ));
  if (!hold || hold.type !== venueConflictModel.ENTRY_TYPES.HOLD || hold.venueId !== venueId
      || !venueConflictModel.isHoldActive(hold, new Date())) {
    throw venueError("INCIDENT_NOT_RESTORABLE");
  }
  return { range: { start: hold.occupiedStart, end: hold.occupiedEnd }, start: hold.start };
};

// Under the lock: refuses while any active block overlaps the range, naming the blocks.
const requireNoActiveBlocks = async (venueId, range) => {
  const entries = await calendarCall(() => venueCalendarModel.findCalendarEntries(
    [venueId], range.start, range.end, { maxTimeMS: MONGO_READ_UNDER_LOCK_MS }
  ));
  const blocking = venueConflictModel.findActiveBlocks(entries, range);
  if (!blocking.length) return;
  throw venueError("INCIDENT_STILL_BLOCKED", {
    blocks: blocking.map((block) => ({
      start: toIsoOrNull(block.start),
      end: toIsoOrNull(block.end),
      reasonLabel: blockReasonLabel(block.reason),
    })),
  });
};

const restoreVenueIncident = async ({ actorId, incidentId, idempotencyKey }) => {
  const requestHash = hashRequest({ incidentId }, {}, []);
  const [row] = await findIncidents({ incidentIds: [incidentId] });
  if (!row) throw venueError("INCIDENT_NOT_FOUND");
  const venueId = await findIncidentVenueId(row);
  if (!venueId) throw venueError("INCIDENT_NOT_FOUND");
  const minutes = await calendarCall(() => readVenueMinutes(venueId));

  const result = await withAffectedEventLocks([row.event_id], async (client) => {
    const started = await selectResult(client,
      "SELECT public.begin_venue_incident_restore($1, $2, $3, $4, $5, $6, $7) AS result",
      [actorId, incidentId, venueId, minutes.setup, minutes.turnaround, idempotencyKey, requestHash]
    );
    if (started.replay) return started.replay;

    const { range, start } = await readRestoreTarget(started.incident, venueId);
    await requireNoActiveBlocks(venueId, range);

    return selectResult(client,
      "SELECT public.restore_venue_incident($1, $2, $3, $4, $5, $6) AS result",
      [actorId, incidentId, venueId, start ? new Date(start).toISOString() : null, idempotencyKey, requestHash]
    );
  });

  return {
    ...result,
    requestId: formatRequestId(result.eventId),
    statusLabel: incidentStatusLabel(result.status),
    resolutionLabel: incidentResolutionLabel(result.resolution),
  };
};

module.exports = {
  createVenueBlock,
  changeVenueBlock,
  restoreVenueIncident,
  listVenueBlocks,
  INCIDENT_AUDIENCE,
  requestVenueBookings,
  listEventVenueBookings,
  withVenueLockTransaction,
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
