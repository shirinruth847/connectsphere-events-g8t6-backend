const { getMongoDb } = require("../config/mongodb");

// Field names follow mongodb/schemas/venue_details.json.
const DETAIL_PROJECTION = {
  description: 1,
  facilities: 1,
  accessibilityFeatures: 1,
  supportedLayouts: 1,
  emergencyAccess: 1,
  knownRestrictions: 1,
};

// Returns a Map keyed by the venue ID as a string; venues without a document
// are absent from it.
const getVenueDetailsByIds = async (venueIds) => {
  if (!venueIds.length) return new Map();

  const db = await getMongoDb();
  const documents = await db
    .collection("venue_details")
    .find({ _id: { $in: venueIds.map(String) } }, { projection: DETAIL_PROJECTION })
    .toArray();

  return new Map(documents.map((document) => [document._id, document]));
};

module.exports = { getVenueDetailsByIds };
