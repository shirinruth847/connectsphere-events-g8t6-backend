// venue_details gains relatedVenueIds: display-only links between venues that
// share a building, e.g. a hall and its rooms, each its own bookable venue
// (developer request of 24 October 2026).
const venueDetailsSchema = require("../schemas/venue_details.json");

const VALIDATION = { validationLevel: "strict", validationAction: "error" };

const up = async (db) => {
  await db.command({ collMod: "venue_details", validator: venueDetailsSchema, ...VALIDATION });
};

module.exports = { id: "0004_venue_related_venues", up };
