const { getMongoDb } = require("../config/mongodb");

const COLLECTION = "equipment_details";

// Field names follow mongodb/schemas/equipment_details.json.
const DETAIL_PROJECTION = {
  pg_version: 1,
  name: 1,
  category: 1,
  specifications: 1,
  technicalNotes: 1,
  handlingNotes: 1,
  updatedAt: 1,
};

// The document fields an outbox entry may set; anything else in a payload is ignored.
const PAYLOAD_FIELDS = Object.freeze(["name", "category", "specifications", "technicalNotes", "handlingNotes"]);

const getEquipmentDetail = async (equipmentId) => {
  const db = await getMongoDb();
  return db.collection(COLLECTION).findOne({ _id: String(equipmentId) }, { projection: DETAIL_PROJECTION });
};

// Applies one outbox entry: the document takes the entry's snapshot only when
// its pg_version is lower, so a late or repeated entry never overwrites newer
// data (Master 6.5). Returns true when the document changed, false when the
// entry was stale.
const applyEquipmentDetail = async ({ equipmentId, pgVersion, payload }) => {
  const db = await getMongoDb();
  const set = { pg_version: pgVersion, updatedAt: new Date() };
  for (const field of PAYLOAD_FIELDS) set[field] = payload[field] ?? null;
  try {
    const result = await db.collection(COLLECTION).updateOne(
      { _id: String(equipmentId), pg_version: { $lt: pgVersion } },
      { $set: set },
      { upsert: true }
    );
    return result.modifiedCount + result.upsertedCount > 0;
  } catch (error) {
    // The filter missed because the document is already at this version or
    // newer, so the upsert collided with it: the entry is stale.
    if (error.code === 11000) return false;
    throw error;
  }
};

module.exports = { getEquipmentDetail, applyEquipmentDetail, PAYLOAD_FIELDS };
