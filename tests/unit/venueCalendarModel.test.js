// Runs against a local in-memory MongoDB (Master M7), never Atlas.
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.setTimeout(120000);

const ORIGINAL_ENV = { ...process.env };
let server;
let db;
let calendarModel;
let detailModel;
let closeMongoDb;

const at = (time, day = "2026-11-04") => new Date(`${day}T${time}:00+08:00`);
const NOW = at("08:00", "2026-11-01");

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  process.env.MONGODB_URI = server.getUri();
  process.env.MONGODB_DB_NAME = "spm74_unit";
  calendarModel = require("../../model/venueCalendarModel");
  detailModel = require("../../model/venueDetailModel");
  const { applyMigrations } = require("../../mongodb/migrate");
  const mongo = require("../../config/mongodb");
  closeMongoDb = mongo.closeMongoDb;
  db = await mongo.getMongoDb();
  await applyMigrations(db);
});

afterAll(async () => {
  await closeMongoDb();
  await server.stop();
  process.env = ORIGINAL_ENV;
});

beforeEach(async () => {
  await db.collection("venue_calendar").deleteMany({});
  await db.collection("venue_details").deleteMany({});
});

const entry = (overrides) => ({
  venueId: "45",
  type: "HOLD",
  start: at("10:00"),
  end: at("12:00"),
  occupiedStart: at("09:30"),
  occupiedEnd: at("12:45"),
  status: "ACTIVE",
  eventId: 500,
  holdExpiresAt: at("09:00", "2026-11-02"),
  createdAt: NOW,
  version: 1,
  ...overrides,
});

describe("venue_calendar validator (Master 6.4, T27)", () => {
  test("should_accept_a_hold_and_a_block", async () => {
    await expect(db.collection("venue_calendar").insertOne(entry())).resolves.toBeTruthy();
    await expect(db.collection("venue_calendar").insertOne(entry({
      type: "BLOCK", eventId: null, holdExpiresAt: null, reason: "MAINTENANCE", note: "Lift repair",
    }))).resolves.toBeTruthy();
  });

  test.each([
    ["an unknown type", { type: "BOOKING" }],
    ["an unknown block reason", { type: "BLOCK", reason: "HOLIDAY" }],
    ["a missing occupied range", { occupiedStart: undefined }],
    ["an extra field", { capacity: 200 }],
  ])("should_reject_%s", async (_, overrides) => {
    const document = entry(overrides);
    for (const key of Object.keys(document)) if (document[key] === undefined) delete document[key];
    await expect(db.collection("venue_calendar").insertOne(document)).rejects.toMatchObject({ code: 121 });
  });
});

test("[Master 10.4] the seed fixtures pass the venue_calendar validator", async () => {
  const { calendarFixtures } = require("../../mongodb/seed/venueCalendarSeed");
  const fixtures = calendarFixtures(NOW);
  await expect(db.collection("venue_calendar").insertMany(fixtures)).resolves.toMatchObject({ insertedCount: fixtures.length });
});

describe("findCalendarEntries", () => {
  test("[SPM-74-AC] should_return_entries_overlapping_the_range_for_the_requested_venues", async () => {
    await db.collection("venue_calendar").insertMany([
      entry(),
      entry({ venueId: "46" }),
      entry({ occupiedStart: at("09:00", "2026-11-06"), occupiedEnd: at("10:00", "2026-11-06") }),
      entry({ status: "RELEASED" }),
      entry({ status: "EXPIRED" }),
    ]);

    const result = await calendarModel.findCalendarEntries([45], at("00:00"), at("00:00", "2026-11-05"));

    expect(result.map((item) => [item.venueId, item.status])).toEqual([[45, "ACTIVE"], [45, "EXPIRED"]]);
    expect(result[0]).toMatchObject({ type: "HOLD", eventId: 500, id: expect.any(String) });
  });

  test("[SPM-74-TC5] should_leave_out_an_entry_that_only_touches_the_range", async () => {
    await db.collection("venue_calendar").insertOne(entry({ occupiedStart: at("22:00", "2026-11-03"), occupiedEnd: at("00:00") }));

    await expect(calendarModel.findCalendarEntries([45], at("00:00"), at("00:00", "2026-11-05"))).resolves.toEqual([]);
  });
});

test("[SPM-199 AC4/8/9] event holds exclude other events, blocks and staff notes", async () => {
  await db.collection("venue_calendar").insertMany([
    entry({ label: "owned", note: "Private staff note", createdBy: 99 }),
    entry({ label: "expired", status: "EXPIRED" }),
    entry({ label: "converted", status: "CONVERTED" }),
    entry({ label: "other event", eventId: 501 }),
    entry({ label: "block", type: "BLOCK", holdExpiresAt: null, reason: "SAFETY" }),
  ]);
  const holds = await calendarModel.findEventHolds(500);
  expect(holds.map((hold) => hold.label).sort()).toEqual(["converted", "expired", "owned"]);
  expect(JSON.stringify(holds)).not.toContain("Private staff note");
  expect(holds.every((hold) => hold.note === null)).toBe(true);
});

describe("saveVenueDetails (Master 7.4)", () => {
  const save = (expectedVersion, fields) =>
    detailModel.saveVenueDetails({
      venueId: 7,
      expectedVersion,
      fields,
      name: "Hall",
      location: "1 Road",
      pgVersion: 1,
      actorId: 3,
    });

  test("should_create_then_update_with_an_increasing_version", async () => {
    const created = await save(0, { setupMinutes: 30, turnaroundMinutes: 45 });
    expect(created).toMatchObject({ setupMinutes: 30, turnaroundMinutes: 45, version: 1, updatedBy: 3 });

    const updated = await save(1, { facilities: ["Stage"] });
    expect(updated).toMatchObject({ setupMinutes: 30, facilities: ["Stage"], version: 2 });
  });

  test("should_refuse_a_stale_version", async () => {
    await save(0, { setupMinutes: 30 });

    await expect(save(0, { setupMinutes: 15 })).rejects.toMatchObject({ code: "VENUE_DETAILS_VERSION_CONFLICT" });
    await expect(save(5, { setupMinutes: 15 })).rejects.toMatchObject({ code: "VENUE_DETAILS_VERSION_CONFLICT" });
    await expect(detailModel.getVenueDetail(7)).resolves.toMatchObject({ setupMinutes: 30, version: 1 });
  });

  test("[Master 5.4.1] should_refuse_to_overwrite_minutes_already_set_even_at_the_right_version", async () => {
    await save(0, { setupMinutes: 30 });
    const guarded = (fields) => detailModel.saveVenueDetails({
      venueId: 7, expectedVersion: 1, fields, name: "Hall", location: "1 Road", pgVersion: 1, actorId: 3, unsetFields: Object.keys(fields),
    });

    await expect(guarded({ setupMinutes: 45 })).rejects.toMatchObject({ code: "VENUE_DETAILS_VERSION_CONFLICT" });
    await expect(guarded({ turnaroundMinutes: 45 })).resolves.toMatchObject({ setupMinutes: 30, turnaroundMinutes: 45, version: 2 });
  });

  test("should_let_the_validator_reject_minutes_outside_the_schema", async () => {
    await expect(save(0, { setupMinutes: 2000 })).rejects.toMatchObject({ code: 121 });
  });
});
