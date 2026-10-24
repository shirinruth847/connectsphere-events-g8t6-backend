const { getMongoDb } = require("../config/mongodb");

// Field names follow mongodb/schemas/venue_details.json.
const DETAIL_PROJECTION = {
  description: 1,
  facilities: 1,
  accessibilityFeatures: 1,
  supportedLayouts: 1,
  emergencyAccess: 1,
  knownRestrictions: 1,
  setupMinutes: 1,
  turnaroundMinutes: 1,
  version: 1,
  updatedAt: 1,
  updatedBy: 1,
};

// The fields Venue Staff edit (SPM-73); MongoDB owns all of them (Master 6.4, T27).
const EDITABLE_DETAIL_FIELDS = Object.freeze([
  "description",
  "facilities",
  "accessibilityFeatures",
  "supportedLayouts",
  "emergencyAccess",
  "knownRestrictions",
  "setupMinutes",
  "turnaroundMinutes",
]);

const detailError = (code) => Object.assign(new Error(code), { name: "VenueError", code });

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

const getVenueDetail = async (venueId) => {
  const db = await getMongoDb();
  return db.collection("venue_details").findOne({ _id: String(venueId) }, { projection: DETAIL_PROJECTION });
};

// Saves the detail fields when the document is still at expectedVersion (0 for
// a venue without a document yet), so a stale edit or a concurrent calendar
// write is refused (Master 7.4). unsetFields must still be empty in the stored
// document: setup/turnaround minutes are set once (Master 5.4.1). name/location/
// pgVersion are the PostgreSQL display copies required by the validator.
const saveVenueDetails = async ({ venueId, expectedVersion, fields, name, location, pgVersion, actorId, unsetFields = [] }) => {
  const db = await getMongoDb();
  const collection = db.collection("venue_details");
  const now = new Date();
  const set = { ...fields, name, location, pg_version: pgVersion, updatedAt: now, updatedBy: actorId };

  if (expectedVersion === 0) {
    try {
      await collection.insertOne({ _id: String(venueId), ...set, version: 1 });
    } catch (error) {
      // Someone created the document since it was loaded.
      if (error.code === 11000) throw detailError("VENUE_DETAILS_VERSION_CONFLICT");
      throw error;
    }
  } else {
    // { field: null } matches a missing or null value.
    const stillUnset = Object.fromEntries(unsetFields.map((field) => [field, null]));
    const result = await collection.updateOne(
      { _id: String(venueId), version: expectedVersion, ...stillUnset },
      { $set: set, $inc: { version: 1 } }
    );
    if (result.matchedCount === 0) throw detailError("VENUE_DETAILS_VERSION_CONFLICT");
  }
  return getVenueDetail(venueId);
};

module.exports = { getVenueDetailsByIds, getVenueDetail, saveVenueDetails, EDITABLE_DETAIL_FIELDS };
