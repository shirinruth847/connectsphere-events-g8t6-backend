const supabase = require("../config/supabase");
const venueDetailModel = require("./venueDetailModel");
const { VENUE_STATUS } = require("../config/venueConstants");
const { MESSAGES } = require("../validators/venueValidator");

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
  setupTurnaroundMinutes: row.setup_turnaround_min,
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

// Available venues only: not deleted as unusable (is_active, SPM-72) and in
// service (status ACTIVE, SPM-73). Deleted and inactive rows are kept for history.
const getVenueCatalogue = async () => {
  const { data, error } = await supabase
    .from("venue")
    .select(VENUE_SELECT)
    .eq("is_active", true)
    .eq("status", VENUE_STATUS.ACTIVE)
    .order("name", { ascending: true })
    .order("venue_id", { ascending: true });
  if (error) throw error;

  const rows = data || [];
  try {
    const details = await venueDetailModel.getVenueDetailsByIds(rows.map((row) => row.venue_id));
    return {
      venues: rows.map((row) => {
        const document = details.get(String(row.venue_id));
        return mapVenue(row, document, document ? "CURRENT" : "NOT_AVAILABLE");
      }),
      detailsAvailable: true,
    };
  } catch (error) {
    console.warn("[venue-catalogue] MongoDB detail read unavailable", { code: error.code });
    return { venues: rows.map((row) => mapVenue(row, null, "NOT_CHECKED")), detailsAvailable: false };
  }
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

module.exports = {
  getVenueCatalogue,
  listManagedVenues,
  findManagedVenueRow,
  getManagedVenue,
  createVenue,
  updateVenue,
  setVenueStatus,
};
