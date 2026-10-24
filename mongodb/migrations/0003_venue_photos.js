// T28 (Master 1.3): venue photo galleries. One document per photo, read by
// venue and ordered by position.
const schema = require("../schemas/venue_photos.json");

const VALIDATION = { validationLevel: "strict", validationAction: "error" };

const up = async (db) => {
  const existing = await db.listCollections({ name: "venue_photos" }).toArray();
  if (existing.length) {
    await db.command({ collMod: "venue_photos", validator: schema, ...VALIDATION });
  } else {
    await db.createCollection("venue_photos", { validator: schema, ...VALIDATION });
  }
  await db.collection("venue_photos").createIndex({ venueId: 1, position: 1 }, { name: "venue_position" });
};

module.exports = { id: "0003_venue_photos", up };
