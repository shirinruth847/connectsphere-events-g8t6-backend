const supabase = require("../config/supabase");

// Equipment catalogue
const getEquipmentList = async () => {
  const { data, error } = await supabase.from("equipment").select("*");
  if (error) throw error;
  return data;
};

// Book a room for an event
const createVenueBooking = async (bookingData) => {
  const { data, error } = await supabase
    .from("venue_booking")
    .insert([bookingData])
    .select()
    .single();
  if (error) throw error;
  return data;
};

// Request equipment for an event
const createEquipmentRequest = async (requestData) => {
  const { data, error } = await supabase
    .from("equipment_request")
    .insert([requestData])
    .select()
    .single();
  if (error) throw error;
  return data;
};

module.exports = { getEquipmentList, createVenueBooking, createEquipmentRequest };