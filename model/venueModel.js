const supabase = require("../config/supabase");
const { getVenueLockPool } = require("../config/venueLockDatabase");
const venueDetailModel = require("./venueDetailModel");
const venueCalendarModel = require("./venueCalendarModel");
const venueConflictModel = require("./venueConflictModel");
const venuePhotoModel = require("./venuePhotoModel");
const activityModel = require("./activityModel");
const { VENUE_STATUS } = require("../config/venueConstants");
const { MESSAGES } = require("../validators/venueValidator");
const { DECISION_MESSAGES } = require("../validators/venueBookingValidator");
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

// Events with bookings still ahead at a venue being taken out of service
// (Master 5.4.4): what Venue Staff confirm, never participant data.
const toAffectedEvents = (items) =>
  (Array.isArray(items) ? items : []).map((item) => ({
    eventId: item.eventId,
    requestId: item.requestId,
    title: item.title,
    status: item.status,
    firstStart: item.firstStart,
    bookings: item.bookings,
  }));

// Database failures that are the client's fault become VenueErrors; anything
// else is rethrown and answered with a safe 500.
const RPC_ERRORS = new Set([
  "FORBIDDEN",
  "VENUE_NOT_FOUND",
  "VENUE_VERSION_CONFLICT",
  "VENUE_NAME_TAKEN",
  "BOOKING_NOT_FOUND",
  "EVENT_NOT_IN_PLANNING",
  "EVENT_NOT_ACTIVE",
  "VENUE_NOT_AVAILABLE",
  "VENUE_CAPACITY_EXCEEDED",
  "VENUE_BUFFERS_NOT_SET",
  "VENUE_BOOKING_CONFLICT",
  "BOOKING_ALREADY_STARTED",
]);
const CONSTRAINT_FIELDS = Object.freeze({
  venue_max_capacity_positive_check: { maxCapacity: MESSAGES.capacityInvalid },
  venue_maintenance_reason_check: { reason: MESSAGES.reasonRequired },
});

const readErrorDetails = (error) => {
  try {
    return JSON.parse(error.details || "{}");
  } catch {
    // Keep the error even if the detail cannot be read.
    return {};
  }
};

const toVenueError = (error) => {
  const message = error.message || "";
  const code = error.code || "";
  if (RPC_ERRORS.has(message)) return venueError(message);
  if (message === "VENUE_HAS_UPCOMING_BOOKINGS") {
    const details = readErrorDetails(error);
    return venueError("VENUE_HAS_UPCOMING_BOOKINGS", {
      upcomingBookings: details.upcomingBookings ?? null,
      firstStart: details.firstStart ?? null,
      affectedEvents: toAffectedEvents(details.affectedEvents),
    });
  }
  if (message === "BOOKING_ALREADY_DECIDED") {
    return venueError("BOOKING_ALREADY_DECIDED", { currentStatus: readErrorDetails(error).status ?? null });
  }
  if (message === "REJECTION_REASON_INVALID") return venueError("VALIDATION_FAILED", { fields: { reason: DECISION_MESSAGES.reasonRequired } });
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
  // One box searches name and location (SPM-186); "location" still narrows by address.
  if (search) query = query.or(orIlike(["name", "address"], search));
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

// A serialization failure (40001) re-runs the whole operation, every check
// included (Master 7); anything else is answered at once.
const SERIALIZATION_RETRIES = 3;

const callVenueRpc = async (name, args) => {
  let result;
  for (let attempt = 1; ; attempt += 1) {
    result = await supabase.rpc(name, args);
    if (!result.error || result.error.code !== "40001" || attempt >= SERIALIZATION_RETRIES) break;
  }
  const { data, error } = result;
  if (error) throw toVenueError(error);
  if (!data || !data.venue) throw new Error(`${name} returned no venue.`);
  return {
    venue: toManagedVenue(data.venue, await findUserNames([data.venue])),
    changed: data.changed === true,
    upcomingBookings: data.upcoming_bookings ?? 0,
    affectedEvents: toAffectedEvents(data.affected_events),
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

// A deleted venue's history is "not found", like the venue itself (SPM-186).
const findVenueHistory = async (venueId, pagination) => {
  await requireVenueRow(venueId);
  return activityModel.findVenueHistory(venueId, pagination);
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

const AVAILABILITY_VENUE_SELECT = "venue_id,name,address,operating_hours,status,status_reason";
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
        // Why a venue is out of service, shown on the calendar (SPM-186).
        statusReason: row.status_reason ?? null,
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
  "room:room!inner(room_id,layout_type,capacity,venue:venue!inner(venue_id,name,address,max_capacity,operating_hours))";
const BOOKING_FIELDS =
  "booking_id,label,status,start_datetime,end_datetime,expected_attendance,layout_type,required_facilities,accessibility_requirements,special_requirements,rejection_reason,reviewed_at,created_at,updated_at,event_id,reviewer:user!venue_booking_reviewed_by_fkey(name)";
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

// Setup and turnaround come from MongoDB venue_details (Master 6.4), not the
// deprecated setup_turnaround_min column; `detailsAvailable` is false when
// MongoDB could not be read, so the minutes are unknown rather than unset.
const toBookingVenue = (room, details = null) => {
  const detail = details ? details.get(String(room.venue.venue_id)) ?? null : null;
  return {
    venueId: room.venue.venue_id,
    name: room.venue.name,
    address: room.venue.address,
    maxCapacity: room.venue.max_capacity,
    operatingHours: room.venue.operating_hours,
    setupMinutes: Number.isInteger(detail?.setupMinutes) ? detail.setupMinutes : null,
    turnaroundMinutes: Number.isInteger(detail?.turnaroundMinutes) ? detail.turnaroundMinutes : null,
    detailsAvailable: Boolean(details),
    roomId: room.room_id,
    roomLayoutType: room.layout_type,
    roomCapacity: room.capacity,
  };
};

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

const DECISION_CLOSED_EVENT_STATUSES = new Set([EVENT_STATUS.COMPLETED, EVENT_STATUS.CANCELLED, EVENT_STATUS.REJECTED]);

// Which decisions Venue Staff may take now (SPM-186 AC4, SPM-189 AC6, T32):
// the database re-checks every rule when the decision is submitted.
const toDecisionActions = (row, eventStatus, now) => {
  const eventOpen = !DECISION_CLOSED_EVENT_STATUSES.has(eventStatus);
  return {
    canApprove: row.status === "PENDING" && eventStatus === EVENT_STATUS.PLANNING,
    canReject:
      eventOpen
      && (row.status === "PENDING" || (row.status === "APPROVED" && new Date(row.start_datetime).getTime() > now)),
  };
};

const toBookingDetail = (row, eventStatus, now = Date.now(), details = null) => ({
  ...toBookingSummary(row),
  venue: toBookingVenue(row.room, details),
  layoutType: row.layout_type,
  requiredFacilities: row.required_facilities || [],
  accessibilityRequirements: row.accessibility_requirements || [],
  specialRequirements: row.special_requirements,
  rejectionReason: row.rejection_reason,
  reviewedAt: row.reviewed_at ?? null,
  reviewedByName: row.reviewer?.name ?? null,
  actions: toDecisionActions(row, eventStatus, now),
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
    // Request status (SPM-186): booking_status enum order, Pending → Approved →
    // Rejected → Cancelled, or the reverse; the soonest booking first within each.
    ? query.order("status", { ascending }).order("start_datetime", { ascending: true })
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

  // The dashboard counts cover every booking, whatever the search or filters.
  const countWithStatus = (bookingStatus) =>
    supabase.from("venue_booking").select("booking_id", { count: "exact", head: true }).eq("status", bookingStatus);
  const [list, pending, approved] = await Promise.all([query, countWithStatus("PENDING"), countWithStatus("APPROVED")]);
  if (list.error) throw list.error;
  if (pending.error) throw pending.error;
  if (approved.error) throw approved.error;

  const rows = list.data || [];
  return {
    bookings: rows.slice(0, limit).map(toBookingListItem),
    hasMore: rows.length > limit,
    pendingCount: pending.count ?? 0,
    approvedCount: approved.count ?? 0,
  };
};

// The event and every booking under it, or null when the event has no
// bookings or is still a private draft: Venue Staff reach events only
// through their bookings.
// One booking's venue calendar for Venue Staff (SPM-186): the booking's own
// window is the checked period, and its event's own bookings and holds are left
// out, so the request is not shown overlapping itself. Null when the booking
// does not exist or its event is a private draft.
const findBookingAvailability = async (bookingId, { from, to }, viewer) => {
  const { data, error } = await supabase
    .from("venue_booking")
    .select("booking_id,event_id,venue_id,start_datetime,end_datetime,room:room(venue_id),event:event!inner(status)")
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.event.status === EVENT_STATUS.DRAFT) return null;
  const venueId = data.venue_id ?? data.room?.venue_id;
  const availability = await getVenueAvailability({
    from,
    to,
    venueIds: [venueId],
    check: { start: new Date(data.start_datetime), end: new Date(data.end_datetime) },
    excludeEventId: data.event_id,
  }, viewer);
  return { bookingId: data.booking_id, venueId, ...availability };
};

// Venue Staff reach an event only through its venue bookings, and never a
// private draft (SPM-181); the same rule gates its history (SPM-186).
const hasReviewableBookings = async (eventId) => {
  const [eventResult, bookingResult] = await Promise.all([
    supabase.from("event").select("event_id,status").eq("event_id", eventId).maybeSingle(),
    supabase.from("venue_booking").select("booking_id", { count: "exact", head: true }).eq("event_id", eventId),
  ]);
  if (eventResult.error) throw eventResult.error;
  if (bookingResult.error) throw bookingResult.error;
  return Boolean(eventResult.data && eventResult.data.status !== EVENT_STATUS.DRAFT && bookingResult.count > 0);
};

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

  const now = Date.now();
  const [details, checks] = await Promise.all([
    readDetailsOrNull(bookings.map((row) => ({ venue_id: row.room.venue.venue_id }))),
    findBookingChecks(bookings, new Date(now)),
  ]);
  return {
    event: toBookingEvent(event),
    bookings: bookings.map((row) => ({ ...toBookingDetail(row, event.status, now, details), checks: checks.get(row.booking_id) ?? null })),
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

// ---------- venue booking decisions (SPM-186, SPM-189, T32) ----------

// The venue's setup/turnaround minutes and any active block over the booking's
// occupied range (Master 5.4.1, 5.4.4). Minutes are set once, so reading them
// before the database locks the booking cannot race with a change. Without
// MongoDB no approval is made (Master 7.3).
const readApprovalCalendar = async (booking, { maxTimeMS } = {}) => {
  const venueId = booking.room.venue_id;
  try {
    const details = await venueDetailModel.getVenueDetailsByIds([venueId], { maxTimeMS });
    const detail = details.get(String(venueId));
    const setupMinutes = Number.isInteger(detail?.setupMinutes) ? detail.setupMinutes : null;
    const turnaroundMinutes = Number.isInteger(detail?.turnaroundMinutes) ? detail.turnaroundMinutes : null;
    if (setupMinutes === null || turnaroundMinutes === null) return { setupMinutes, turnaroundMinutes, blocked: false };

    const range = venueConflictModel.occupiedRange(booking.start_datetime, booking.end_datetime, setupMinutes, turnaroundMinutes);
    const entries = await venueCalendarModel.findCalendarEntries([venueId], range.start, range.end, { maxTimeMS });
    // Unexpired holds of other events occupy the venue too (Master 5.4.3).
    const conflicts = findCalendarConflicts(entries, { venueId, range, now: new Date() });
    return {
      setupMinutes,
      turnaroundMinutes,
      blocked: conflicts.some((entry) => entry.type === venueConflictModel.ENTRY_TYPES.BLOCK),
      held: conflicts.some((entry) => entry.type === venueConflictModel.ENTRY_TYPES.HOLD),
    };
  } catch (error) {
    throw mongoUnavailable(error);
  }
};

// A pg error from the venue lock connection, in the shape toVenueError reads.
const toDecisionError = (error) => {
  if (error?.name === "VenueError") return error;
  if (RETRYABLE_LOCK_CODES.has(error?.code)) return venueError("VENUE_LOCK_TIMEOUT");
  if (SESSION_ENDED_CODES.has(error?.code) || String(error?.code ?? "").startsWith("08")) return venueError("VENUE_BOOKINGS_UNAVAILABLE");
  if (error?.code === "P0001" || error?.code === "P0002") return toVenueError({ message: error.message, details: error.detail, code: error.code });
  return error;
};

// Approval holds the event and venue locks on the venue lock connection while
// it reads the venue's minutes, holds and blocks from MongoDB, then decides in
// the same transaction (Master 7.4, T33), so no hold or block can slip in
// between the check and the commit. A rejection frees time and needs no lock.
const approveUnderVenueLock = (actorId, bookingId, expectedStatus) => withVenueLockTransaction(async (client) => {
  const locked = (await client.query(
    "SELECT public.begin_venue_booking_decision($1, $2) AS result",
    [actorId, bookingId],
  )).rows[0].result;

  let calendar = { setupMinutes: null, turnaroundMinutes: null };
  if (locked.status === "PENDING") {
    calendar = await readApprovalCalendar(
      { room: { venue_id: locked.venueId }, start_datetime: locked.start, end_datetime: locked.end },
      { maxTimeMS: MONGO_READ_UNDER_LOCK_MS },
    );
    if (calendar.blocked) throw venueError("VENUE_BLOCKED");
    if (calendar.held) throw venueError("VENUE_HELD");
  }
  await client.query(
    "SELECT public.decide_venue_booking($1, $2, 'APPROVE', $3, NULL, $4, $5)",
    [actorId, bookingId, expectedStatus, calendar.setupMinutes, calendar.turnaroundMinutes],
  );
});

const decideVenueBooking = async (actorId, bookingId, decision, { expectedStatus = null, reason = null } = {}) => {
  if (decision === "APPROVE") {
    try {
      await approveUnderVenueLock(actorId, bookingId, expectedStatus);
    } catch (error) {
      throw toDecisionError(error);
    }
  } else {
    const { error } = await supabase.rpc("decide_venue_booking", {
      p_actor_id: actorId,
      p_booking_id: bookingId,
      p_decision: decision,
      p_expected_status: expectedStatus,
      p_reason: reason,
      p_setup_minutes: null,
      p_turnaround_minutes: null,
    });
    if (error) throw toVenueError(error);
  }

  const result = await findVenueBooking(bookingId);
  if (!result) throw new Error("decide_venue_booking left no readable booking.");
  return result;
};

const approveVenueBooking = (actorId, bookingId, values) => decideVenueBooking(actorId, bookingId, "APPROVE", values);

const rejectVenueBooking = (actorId, bookingId, values) => decideVenueBooking(actorId, bookingId, "REJECT", values);

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

const toBookingRequestError = (error) => {
  if (error?.name === "VenueError") return error;
  if (RETRYABLE_LOCK_CODES.has(error?.code)) return venueError("VENUE_LOCK_TIMEOUT");
  // Class 08 is a connection exception.
  if (SESSION_ENDED_CODES.has(error?.code) || String(error?.code ?? "").startsWith("08")) {
    return venueError("VENUE_BOOKINGS_UNAVAILABLE");
  }
  if ((error?.code === "P0001" || error?.code === "P0002") && BOOKING_REQUEST_ERRORS.has(error.message)) {
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

// ---------- per-booking fit (SPM-186, Master 5.4, 5.4.2) ----------

const FIT_VENUE_SELECT = "venue_id,name,max_capacity,operating_hours,status,status_reason,is_active";
const FIT_BOOKING_SELECT = "booking_id,event_id,venue_id,status,start_datetime,end_datetime,occupied_range";
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", day: "numeric", month: "short" });
const formatInstant = (value) => {
  const time = new Date(value);
  return `${dayFormat.format(time)} ${venueConflictModel.formatLocal(time.getTime())}`;
};
const formatRange = (start, end) => {
  const from = new Date(start);
  const to = new Date(end);
  const day = dayFormat.format(from);
  const endDay = dayFormat.format(to);
  const times = `${venueConflictModel.formatLocal(from.getTime())}–${venueConflictModel.formatLocal(to.getTime())}`;
  return day === endDay ? `${day}, ${times}` : `${day} ${venueConflictModel.formatLocal(from.getTime())} – ${endDay} ${venueConflictModel.formatLocal(to.getTime())}`;
};

// Everything the fit of these bookings depends on, read once: the venues
// (PostgreSQL), active bookings near the windows (PostgreSQL), and setup and
// turnaround minutes, holds and blocks (MongoDB). An unreadable MongoDB leaves
// detailsRead false, so availability is "not checked", never "available".
const loadFitContext = async (items) => {
  const venueIds = [...new Set(items.map((item) => item.venueId))];
  if (!venueIds.length) return { venues: new Map(), bookings: [], details: new Map(), entries: [], detailsRead: true };
  const times = items.flatMap((item) => [Date.parse(item.start), Date.parse(item.end)]);
  const from = new Date(Math.min(...times) - BUFFER_MARGIN_MS);
  const to = new Date(Math.max(...times) + BUFFER_MARGIN_MS);

  const [venueResult, bookingResult] = await Promise.all([
    supabase.from("venue").select(FIT_VENUE_SELECT).in("venue_id", venueIds),
    supabase
      .from("venue_booking")
      .select(FIT_BOOKING_SELECT)
      .in("venue_id", venueIds)
      .in("status", ACTIVE_BOOKING_STATUSES)
      .lt("start_datetime", to.toISOString())
      .gt("end_datetime", from.toISOString()),
  ]);
  if (venueResult.error) throw venueResult.error;
  if (bookingResult.error) throw bookingResult.error;

  let details = new Map();
  let entries = [];
  let detailsRead = true;
  try {
    [details, entries] = await Promise.all([
      venueDetailModel.getVenueDetailsByIds(venueIds),
      venueCalendarModel.findCalendarEntries(venueIds, from, to),
    ]);
  } catch (error) {
    console.warn("[venue-booking-fit] MongoDB unavailable", { code: error.code, name: error.name });
    detailsRead = false;
  }

  const venues = new Map((venueResult.data || []).map((row) => [row.venue_id, {
    venueId: row.venue_id,
    name: row.name,
    maxCapacity: row.max_capacity,
    operatingHours: row.operating_hours,
    status: row.status,
    statusReason: row.status_reason,
    isActive: row.is_active,
  }]));
  const bookings = (bookingResult.data || []).map((row) => {
    const { occupiedStart, occupiedEnd } = parseOccupiedRange(row.occupied_range);
    const detail = details.get(String(row.venue_id));
    // A booking saved before occupied ranges were stored uses today's minutes.
    const range = occupiedStart && occupiedEnd
      ? { start: new Date(occupiedStart), end: new Date(occupiedEnd) }
      : venueConflictModel.occupiedRange(row.start_datetime, row.end_datetime, detail?.setupMinutes, detail?.turnaroundMinutes);
    return { bookingId: row.booking_id, eventId: row.event_id, venueId: row.venue_id, status: row.status, range };
  });
  return { venues, bookings, details, entries, detailsRead };
};

const blockingCheck = (code, message) => ({ code, message });

// One booking against its own venue and its own window: blocking problems
// (Approve and requests are refused) and warnings (Venue Staff decide). Other
// bookings of the same event at other venues never affect the result.
const assessBookingFit = (item, context, { excludeBookingId = null, now = new Date() } = {}) => {
  const venue = context.venues.get(item.venueId);
  const blocking = [];
  const result = (availability, range = null, warnings = []) => ({
    venueId: item.venueId,
    availability,
    occupiedStart: range ? new Date(range.start).toISOString() : null,
    occupiedEnd: range ? new Date(range.end).toISOString() : null,
    blocking,
    warnings,
  });
  if (!venue || !venue.isActive) {
    blocking.push(blockingCheck("VENUE_NOT_FOUND", "This venue no longer exists."));
    return result("UNAVAILABLE");
  }
  if (venue.status !== VENUE_STATUS.ACTIVE) {
    const state = venue.status === VENUE_STATUS.UNDER_MAINTENANCE ? "under maintenance" : "inactive";
    blocking.push(blockingCheck(
      "VENUE_NOT_BOOKABLE",
      `${venue.name} is ${state}${venue.statusReason ? ` (${venue.statusReason})` : ""} and takes no new bookings.`,
    ));
  }
  if (Number.isInteger(item.expectedAttendance) && item.expectedAttendance > venue.maxCapacity) {
    blocking.push(blockingCheck(
      "VENUE_CAPACITY_EXCEEDED",
      `${item.expectedAttendance.toLocaleString("en-GB")} people is more than ${venue.name}'s capacity of ${venue.maxCapacity.toLocaleString("en-GB")}.`,
    ));
  }
  if (!context.detailsRead) {
    blocking.push(blockingCheck("AVAILABILITY_NOT_CHECKED", "Availability cannot be checked right now. Try again shortly."));
    return result("NOT_CHECKED");
  }
  const document = context.details.get(String(item.venueId));
  if (!Number.isInteger(document?.setupMinutes) || !Number.isInteger(document?.turnaroundMinutes)) {
    blocking.push(blockingCheck("VENUE_BUFFERS_NOT_SET", `Setup and turnaround times are not recorded for ${venue.name}.`));
    return result("NOT_CHECKED");
  }

  const range = venueConflictModel.occupiedRange(item.start, item.end, document.setupMinutes, document.turnaroundMinutes);
  context.bookings
    .filter((booking) => booking.venueId === item.venueId && booking.bookingId !== excludeBookingId)
    .filter((booking) => venueConflictModel.overlaps(range, booking.range))
    .forEach((booking) => blocking.push(blockingCheck(
      "VENUE_BOOKING_CONFLICT",
      `Overlaps ${booking.status === "APPROVED" ? "an approved" : "a pending"} booking for ${formatRequestId(booking.eventId)} (${formatRange(booking.range.start, booking.range.end)}).`,
    )));
  findCalendarConflicts(context.entries, { venueId: item.venueId, range, now }).forEach((conflict) => blocking.push(
    conflict.type === venueConflictModel.ENTRY_TYPES.BLOCK
      ? blockingCheck("VENUE_BLOCKED", `Blocked${conflict.reasonLabel ? ` (${conflict.reasonLabel})` : ""} ${formatRange(conflict.occupiedStart, conflict.occupiedEnd)}.`)
      : blockingCheck("VENUE_HELD", `Held for another event ${formatRange(conflict.occupiedStart, conflict.occupiedEnd)}, until ${formatInstant(conflict.holdExpiresAt)}.`),
  ));
  const available = !blocking.some((check) => ["VENUE_BOOKING_CONFLICT", "VENUE_BLOCKED", "VENUE_HELD"].includes(check.code));
  return result(available ? "AVAILABLE" : "UNAVAILABLE", range, bookingWarnings(item, range, venue, document));
};

// POST /api/events/:id/venue-bookings/check (SPM-186): advisory checks for a
// request being prepared; nothing is written and nothing is locked. The
// request itself checks again under the venue lock (Master 7.4).
const checkVenueBookings = async (items, { now = new Date() } = {}) => {
  const ready = items.filter((item) => item.booking);
  const context = await loadFitContext(ready.map((item) => item.booking));
  return items.map((item) => (item.booking
    ? { index: item.index, checked: true, fields: {}, ...assessBookingFit(item.booking, context, { now }) }
    : { index: item.index, checked: false, fields: item.fields, venueId: null, availability: "NOT_CHECKED", occupiedStart: null, occupiedEnd: null, blocking: [], warnings: [] }));
};

// The fit of an event's active bookings for Venue Staff (SPM-186 AC7); each is
// checked without itself. Decided or released bookings have no checks.
const bookingFitItem = (row) => ({
  venueId: row.room.venue.venue_id,
  start: row.start_datetime,
  end: row.end_datetime,
  expectedAttendance: row.expected_attendance,
  layout: row.layout_type || "",
  requiredFacilities: row.required_facilities || [],
  accessibilityNeeds: row.accessibility_requirements || [],
});

const findBookingChecks = async (rows, now = new Date()) => {
  const active = rows.filter((row) => ACTIVE_BOOKING_STATUSES.includes(row.status));
  if (!active.length) return new Map();
  const context = await loadFitContext(active.map(bookingFitItem));
  return new Map(active.map((row) => [row.booking_id, assessBookingFit(bookingFitItem(row), context, { excludeBookingId: row.booking_id, now })]));
};

const toBookingRequestResult = (result) => ({
  ...result,
  bookings: (result.bookings || []).map((item) => ({
    ...item,
    statusLabel: VENUE_BOOKING_STATUS_LABELS[item.status] || item.status,
  })),
});

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

  let discardClient = false;
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${VENUE_LOCK_TIMEOUT}'`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (connectionLost) {
      discardClient = true;
    } else {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
      }
    }
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
      const started = (await client.query(
        "SELECT public.begin_venue_booking_request($1, $2, $3::integer[], $4, $5) AS result",
        [actorId, eventId, venueIds, idempotencyKey, requestHash]
      )).rows[0].result;
      if (started.replay) return started.replay;

      const { minutes, warnings } = await checkVenueCalendar(bookings, started.venues || []);
      return (await client.query(
        "SELECT public.request_venue_bookings($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7) AS result",
        [actorId, eventId, JSON.stringify(bookings), JSON.stringify(minutes), JSON.stringify(warnings), idempotencyKey, requestHash]
      )).rows[0].result;
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
  return bookings;
};

module.exports = {
  requestVenueBookings,
  listEventVenueBookings,
  checkVenueBookings,
  assessBookingFit,
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
  hasReviewableBookings,
  findBookingAvailability,
  findVenueHistory,
  findVenueBooking,
  approveVenueBooking,
  rejectVenueBooking,
};
