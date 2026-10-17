const supabase = require("../config/supabase");
const venueDetailModel = require("./venueDetailModel");

const VENUE_SELECT = `venue_id,name,address,max_capacity,operating_hours,accessibility_features,setup_turnaround_min,rooms:room(room_id,layout_type,capacity)`;

const notCheckedDetails = {
  detailStatus: "NOT_CHECKED",
  description: "not checked",
  facilities: "not checked",
  accessibilityFeatures: "not checked",
  supportedLayouts: "not checked",
  emergencyAccess: "not checked",
  knownRestrictions: "not checked",
};

const mapVenue = (row, details, detailsAvailable) => ({
  venueId: row.venue_id,
  name: row.name,
  address: row.address,
  maxCapacity: row.max_capacity,
  operatingHours: row.operating_hours,
  accessibilityFeatures: detailsAvailable
    ? details?.accessibilityFeatures ?? details?.accessibility_features ?? row.accessibility_features
    : notCheckedDetails.accessibilityFeatures,
  setupTurnaroundMinutes: row.setup_turnaround_min,
  rooms: (row.rooms || []).map((room) => ({
    roomId: room.room_id,
    layoutType: room.layout_type,
    capacity: room.capacity,
  })),
  ...(detailsAvailable ? {
    detailStatus: details ? "CURRENT" : "NOT_AVAILABLE",
    description: details?.description ?? null,
    facilities: details?.facilities ?? [],
    supportedLayouts: details?.supportedLayouts ?? details?.supported_layouts ?? [],
    emergencyAccess: details?.emergencyAccess ?? details?.emergency_access ?? null,
    knownRestrictions: details?.knownRestrictions ?? details?.known_restrictions ?? [],
  } : notCheckedDetails),
});

const getVenueCatalogue = async () => {
  const { data, error } = await supabase
    .from("venue")
    .select(VENUE_SELECT)
    .order("name", { ascending: true })
    .order("venue_id", { ascending: true });
  if (error) throw error;

  const rows = data || [];
  try {
    const details = await venueDetailModel.getVenueDetailsByIds(rows.map((row) => row.venue_id));
    return { venues: rows.map((row) => mapVenue(row, details.get(String(row.venue_id)), true)), detailsAvailable: true };
  } catch (error) {
    console.warn("[venue-catalogue] MongoDB detail read unavailable", { code: error.code });
    return { venues: rows.map((row) => mapVenue(row, null, false)), detailsAvailable: false };
  }
};

// Get all venues incl nested rooms
const getAllVenues = async () => {
  const { data, error } = await supabase
    .from("venue")
    .select(`
      *,
      rooms:room (*)
    `);
  if (error) throw error;
  return data;
};

// Create new venue
const createVenue = async (venueData) => {
  const { data, error } = await supabase
    .from("venue")
    .insert([venueData])
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Add room to venue
const createRoom = async (roomData) => {
  const { data, error } = await supabase
    .from("room")
    .insert([roomData])
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Update venue
const updateVenue = async (venueId, data) => {
  const { data: row, error } = await supabase
    .from("venue")
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq("venue_id", venueId)
    .select()
    .single();
  if (error) throw error;
  return row;
};

module.exports = { getVenueCatalogue, getAllVenues, createVenue, createRoom, updateVenue };
