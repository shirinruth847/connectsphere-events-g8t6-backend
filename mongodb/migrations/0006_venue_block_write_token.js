// SPM-195: optional per-attempt ownership for safe acknowledgement-loss recovery.
const validator = require("../schemas/venue_calendar.json");
module.exports = {
  id: "0006_venue_block_write_token",
  up: async (db) => db.command({ collMod: "venue_calendar", validator, validationLevel: "strict", validationAction: "error" }),
};
