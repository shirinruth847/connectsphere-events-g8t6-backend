const supabase = require("../config/supabase");
const venueDetailModel = require("./venueDetailModel");

const VENUE_SELECT = `venue_id,name,address,max_capacity,operating_hours,accessibility_features,setup_turnaround_min,rooms:room(room_id,layout_type,capacity)`;

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

// Active venues only: a venue deleted as unusable keeps its row (bookings may
// reference it) with is_active = false.
const getVenueCatalogue = async () => {
  const { data, error } = await supabase
    .from("venue")
    .select(VENUE_SELECT)
    .eq("is_active", true)
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

module.exports = { getVenueCatalogue };
