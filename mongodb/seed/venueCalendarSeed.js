// Development data for T27 / SPM-74 (Master 1.2, 10.3.2, 10.4).
//   1. Copies each venue's legacy PostgreSQL setup_turnaround_min into MongoDB
//      venue_details as setupMinutes and turnaroundMinutes, for venues whose
//      document has no minutes yet. The legacy column is one value, so it is
//      used for both; [seed:dev] Grand Hall gets 30/45 to match SPM-74 TC3.
//   2. Adds mock holds and blocks to venue_calendar, tagged
//      fixture: "spm74-dev" so cleanup removes only them.
// Usage: node mongodb/seed/venueCalendarSeed.js [cleanup]
// Reads MONGODB_URI, MONGODB_DB_NAME and the Supabase settings from .env.
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");

const FIXTURE = "spm74-dev";
const GRAND_HALL = 45;
const SEMINAR_CENTRE = 46;
const STUDIO_ROOM = 47;
const at = (time, day) => new Date(`${day}T${time}:00+08:00`);
const DAY_MS = 24 * 60 * 60 * 1000;

const calendarFixtures = (now) => {
  const created = { status: "ACTIVE", createdAt: now, updatedAt: null, createdBy: null, version: 1, fixture: FIXTURE, extendedAt: null, convertedBookingId: null };
  return [
    {
      // Active hold on the day of the seeded two-venue event (REQ-000442).
      ...created,
      venueId: String(GRAND_HALL),
      type: "HOLD",
      start: at("18:00", "2026-11-04"),
      end: at("20:00", "2026-11-04"),
      occupiedStart: at("17:30", "2026-11-04"),
      occupiedEnd: at("20:45", "2026-11-04"),
      eventId: 2,
      label: "Evening reception",
      holdExpiresAt: new Date(Math.min(now.getTime() + 7 * DAY_MS, at("17:30", "2026-11-03").getTime())),
      reason: null,
      note: null,
    },
    {
      // Expired hold: shown as expired, never blocks (SPM-74 TC7).
      ...created,
      venueId: String(GRAND_HALL),
      type: "HOLD",
      start: at("10:00", "2026-11-05"),
      end: at("12:00", "2026-11-05"),
      occupiedStart: at("09:30", "2026-11-05"),
      occupiedEnd: at("12:45", "2026-11-05"),
      eventId: 1,
      label: "Workshop overflow",
      holdExpiresAt: new Date(now.getTime() - DAY_MS),
      reason: null,
      note: null,
    },
    {
      // Maintenance block 08:00–18:00 (SPM-74 TC8) overlapping booking VB-000111.
      ...created,
      venueId: String(SEMINAR_CENTRE),
      type: "BLOCK",
      start: at("08:00", "2026-11-04"),
      end: at("18:00", "2026-11-04"),
      occupiedStart: at("08:00", "2026-11-04"),
      occupiedEnd: at("18:00", "2026-11-04"),
      eventId: null,
      label: null,
      holdExpiresAt: null,
      reason: "MAINTENANCE",
      note: "Air-conditioning service; contractor on site all day.",
    },
    {
      ...created,
      venueId: String(STUDIO_ROOM),
      type: "BLOCK",
      start: at("09:00", "2026-11-06"),
      end: at("13:00", "2026-11-06"),
      occupiedStart: at("09:00", "2026-11-06"),
      occupiedEnd: at("13:00", "2026-11-06"),
      eventId: null,
      label: null,
      holdExpiresAt: null,
      reason: "EQUIPMENT_FAILURE",
      note: "Projector replacement.",
    },
  ];
};

const seedBuffers = async (db) => {
  const { data, error } = await supabase
    .from("venue")
    .select("venue_id,name,address,version,setup_turnaround_min")
    .not("setup_turnaround_min", "is", null);
  if (error) throw error;

  let updated = 0;
  for (const venue of data) {
    const setup = venue.venue_id === GRAND_HALL ? 30 : venue.setup_turnaround_min;
    const turnaround = venue.venue_id === GRAND_HALL ? 45 : venue.setup_turnaround_min;
    const result = await db.collection("venue_details").updateOne(
      { _id: String(venue.venue_id), setupMinutes: { $exists: false } },
      {
        $set: { setupMinutes: setup, turnaroundMinutes: turnaround, updatedAt: new Date(), updatedBy: null },
        $inc: { version: 1 },
        $setOnInsert: { name: venue.name, location: venue.address, pg_version: venue.version },
      },
      { upsert: true }
    ).catch((caught) => {
      // A document that already has minutes matches no filter, and the upsert
      // then collides with its _id: leave it unchanged.
      if (caught.code === 11000) return { modifiedCount: 0, upsertedCount: 0 };
      throw caught;
    });
    updated += result.modifiedCount + result.upsertedCount;
  }
  return updated;
};

const seed = async () => {
  const db = await getMongoDb();
  const buffers = await seedBuffers(db);
  const calendar = db.collection("venue_calendar");
  await calendar.deleteMany({ fixture: FIXTURE });
  const { insertedCount } = await calendar.insertMany(calendarFixtures(new Date()));
  console.log(`venue_details minutes set: ${buffers}; venue_calendar fixtures: ${insertedCount} (fixture "${FIXTURE}")`);
};

const cleanup = async () => {
  const db = await getMongoDb();
  const { deletedCount } = await db.collection("venue_calendar").deleteMany({ fixture: FIXTURE });
  console.log(`Removed ${deletedCount} venue_calendar fixtures (fixture "${FIXTURE}"). Venue minutes are kept.`);
};

if (require.main === module) {
  (process.argv[2] === "cleanup" ? cleanup() : seed())
    .catch((error) => {
      console.error("Venue calendar seed failed:", error.message);
      process.exitCode = 1;
    })
    .finally(closeMongoDb);
}

module.exports = { calendarFixtures, FIXTURE };
