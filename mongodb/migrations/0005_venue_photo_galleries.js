// Per-venue transaction guard; photos remain in venue_photos. The guard is
// created lazily, so existing galleries require no backfill.
const validator = require("../schemas/venue_photo_galleries.json");

const up = async (db) => {
  const options = { validator, validationLevel: "strict", validationAction: "error" };
  if ((await db.listCollections({ name: "venue_photo_galleries" }).toArray()).length) {
    await db.command({ collMod: "venue_photo_galleries", ...options });
  } else {
    await db.createCollection("venue_photo_galleries", options);
  }
};

module.exports = { id: "0005_venue_photo_galleries", up };
