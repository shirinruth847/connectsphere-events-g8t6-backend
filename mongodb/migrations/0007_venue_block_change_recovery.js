// SPM-195: durable change intent stored atomically with the calendar change.
const validator = require("../schemas/venue_calendar.json");
module.exports = {
  id: "0007_venue_block_change_recovery",
  up: async (db) => db.command({ collMod: "venue_calendar", validator, validationLevel: "strict", validationAction: "error" }),
};
