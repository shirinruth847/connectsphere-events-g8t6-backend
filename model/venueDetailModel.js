const { getMongoDb } = require("../config/mongodb");

const DETAIL_PROJECTION = {
  description: 1,
  facilities: 1,
  accessibility_features: 1,
  accessibilityFeatures: 1,
  supported_layouts: 1,
  supportedLayouts: 1,
  emergency_access: 1,
  emergencyAccess: 1,
  known_restrictions: 1,
  knownRestrictions: 1,
};

const getVenueDetailsByIds = async (venueIds) => {
  if (!venueIds.length) return new Map();

  const db = await getMongoDb();
  const ids = venueIds.flatMap((id) => [id, String(id)]);
  const documents = await db
    .collection("venue_details")
    .find({ _id: { $in: ids } }, { projection: DETAIL_PROJECTION })
    .toArray();

  return new Map(documents.map((document) => [String(document._id), document]));
};

module.exports = { getVenueDetailsByIds };
