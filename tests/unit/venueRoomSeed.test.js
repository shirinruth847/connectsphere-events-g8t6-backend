// The development halls and rooms (developer request of 24 October 2026) must
// fit the venue rules. Cleanup checks use only an isolated in-memory MongoDB.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));

const { BUILDINGS, FIXTURE, hallCapacity, restoreSeedLayouts } = require("../../mongodb/seed/venueRoomSeed");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");
const schema = require("../../mongodb/schemas/venue_details.json").$jsonSchema.properties;

const venues = BUILDINGS.flatMap(({ hall, rooms }) => [hall, ...rooms]);

describe("venue room seed data", () => {
  test("[SPM-72] should_make_each_hall_hold_its_rooms_plus_its_common_area", () => {
    for (const building of BUILDINGS) {
      expect(building.rooms.length).toBeGreaterThanOrEqual(2);
      expect(building.hall.commonArea).toBeGreaterThan(0);
      expect(hallCapacity(building)).toBe(building.rooms.reduce((sum, room) => sum + room.capacity, 0) + building.hall.commonArea);
    }
    expect(hallCapacity(BUILDINGS[0])).toBe(600);
  });

  test("[SPM-72] should_give_every_venue_a_unique_seed_name_valid_hours_minutes_and_layouts", () => {
    const names = venues.map(({ name }) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const venue of venues) {
      expect(venue.name).toMatch(/^\[seed:dev\] /);
      expect(venue.operatingHours).toMatch(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-4]):[0-5]\d$/);
      expect(Number.isInteger(venue.setupMinutes) && venue.setupMinutes >= 0).toBe(true);
      expect(Number.isInteger(venue.turnaroundMinutes) && venue.turnaroundMinutes >= 0).toBe(true);
      expect(venue.supportedLayouts.length).toBeGreaterThan(0);
      expect(venue.supportedLayouts.length).toBeLessThanOrEqual(schema.supportedLayouts.maxItems);
      expect(venue.photos.length).toBeGreaterThan(0);
      for (const entry of venue.photos) expect(entry).toHaveLength(3);
    }
  });

  test("[SPM-72] should_tag_documents_for_cleanup", () => {
    expect(FIXTURE).toBe("spm72-rooms");
  });
});

describe("venue seed layout cleanup", () => {
  let server;
  let client;
  let db;
  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    client = new MongoClient(server.getUri());
    await client.connect();
    db = client.db("isolated_seed_cleanup");
  });
  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.stop();
  });
  beforeEach(async () => db.collection("venue_details").deleteMany({}));

  const record = (previousLayouts = null) => ({ venueId: 45, layouts: ["THEATRE"], version: 2, previousLayouts, applied: true });

  test.each([null, []])("should_restore_the_original_%p_value_when_the_seed_write_is_unchanged", async (previousLayouts) => {
    await db.collection("venue_details").insertOne({ _id: "45", version: 2, supportedLayouts: ["THEATRE"] });
    expect(await restoreSeedLayouts(db, [record(previousLayouts)])).toBe(1);
    const result = await db.collection("venue_details").findOne({ _id: "45" });
    expect(result.version).toBe(3);
    if (previousLayouts === null) expect(result).not.toHaveProperty("supportedLayouts");
    else expect(result.supportedLayouts).toEqual([]);
    expect(await restoreSeedLayouts(db, [record(previousLayouts)])).toBe(0);
  });

  test.each([
    [3, ["BANQUET"]],
    [3, ["THEATRE"]],
    [2, ["BANQUET"]],
  ])("should_preserve_later_or_mismatched_data_at_version_%i_with_%p", async (version, supportedLayouts) => {
    const document = { _id: "45", version, supportedLayouts };
    await db.collection("venue_details").insertOne(document);
    expect(await restoreSeedLayouts(db, [record()])).toBe(0);
    expect(await db.collection("venue_details").findOne({ _id: "45" })).toEqual(document);
  });

  test("should_preserve_legacy_manifest_entries_without_restore_evidence", async () => {
    const document = { _id: "45", version: 2, supportedLayouts: ["THEATRE"] };
    await db.collection("venue_details").insertOne(document);
    expect(await restoreSeedLayouts(db, [45])).toBe(0);
    expect(await db.collection("venue_details").findOne({ _id: "45" })).toEqual(document);
  });

  test("should_preserve_data_when_the_seed_write_was_not_confirmed", async () => {
    const document = { _id: "45", version: 2, supportedLayouts: ["THEATRE"] };
    await db.collection("venue_details").insertOne(document);
    expect(await restoreSeedLayouts(db, [{ ...record(), applied: false }])).toBe(0);
    expect(await db.collection("venue_details").findOne({ _id: "45" })).toEqual(document);
  });
});
