// Creates equipment_details with its validator (Master section 6.4, SPM-52).
// Lookups are by _id only, which MongoDB indexes already, so no extra index is
// created.
const schema = require("../schemas/equipment_details.json");

const COLLECTION = "equipment_details";

const up = async (db) => {
  const existing = await db.listCollections({ name: COLLECTION }).toArray();
  if (existing.length) {
    await db.command({ collMod: COLLECTION, validator: schema, validationLevel: "strict", validationAction: "error" });
    return;
  }
  await db.createCollection(COLLECTION, { validator: schema, validationLevel: "strict", validationAction: "error" });
};

module.exports = { id: "0004_equipment_details", up };
