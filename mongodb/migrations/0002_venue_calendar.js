// T27 (Master 1.2): venue_details gains setup/turnaround minutes and a write
// version, and venue_calendar holds tentative holds and operational blocks.
const venueDetailsSchema = require("../schemas/venue_details.json");
const venueCalendarSchema = require("../schemas/venue_calendar.json");

const VALIDATION = { validationLevel: "strict", validationAction: "error" };

const up = async (db) => {
  await db.command({ collMod: "venue_details", validator: venueDetailsSchema, ...VALIDATION });

  const existing = await db.listCollections({ name: "venue_calendar" }).toArray();
  if (existing.length) {
    await db.command({ collMod: "venue_calendar", validator: venueCalendarSchema, ...VALIDATION });
  } else {
    await db.createCollection("venue_calendar", { validator: venueCalendarSchema, ...VALIDATION });
  }
  // The calendar and the overlap checks read one venue's entries by occupied range.
  await db.collection("venue_calendar").createIndex(
    { venueId: 1, occupiedStart: 1, occupiedEnd: 1 },
    { name: "venue_occupied_range" }
  );
};

module.exports = { id: "0002_venue_calendar", up };
