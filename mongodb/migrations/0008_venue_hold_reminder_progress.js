// SPM-190: optional reminder progress; existing calendar documents remain valid.
const validator = require("../schemas/venue_calendar.json");
module.exports = {
  id: "0008_venue_hold_reminder_progress",
  up: async (db) => {
    await db.command({ collMod: "venue_calendar", validator, validationLevel: "strict", validationAction: "error" });
    await db.collection("venue_calendar").createIndex(
      { type: 1, status: 1, holdExpiresAt: 1, _id: 1 }, { name: "hold_expiry_work" }
    );
  },
};
