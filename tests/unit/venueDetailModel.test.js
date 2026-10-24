// Runs against a local in-memory MongoDB (Master M7), never Atlas. The first
// run downloads a mongod binary into the user cache; later runs work offline.
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.setTimeout(120000);

const ORIGINAL_ENV = { ...process.env };
let server;
let db;
let getVenueDetailsByIds;
let applyMigrations;
let closeMongoDb;
let getMongoDb;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  process.env.MONGODB_URI = server.getUri();
  process.env.MONGODB_DB_NAME = "spm72_unit";
  ({ getVenueDetailsByIds } = require("../../model/venueDetailModel"));
  ({ applyMigrations } = require("../../mongodb/migrate"));
  ({ getMongoDb, closeMongoDb } = require("../../config/mongodb"));
  db = await getMongoDb();
  await applyMigrations(db);
});

afterAll(async () => {
  await closeMongoDb();
  await server.stop();
  process.env = ORIGINAL_ENV;
});

const detail = (id, extra = {}) => ({
  _id: String(id),
  pg_version: 1,
  name: `Venue ${id}`,
  location: `${id} Test Road`,
  description: "Quiet hall",
  facilities: ["Projector"],
  accessibilityFeatures: ["Step-free access"],
  supportedLayouts: ["THEATRE"],
  emergencyAccess: "North exit",
  knownRestrictions: [],
  ...extra,
});

describe("mongodb/migrate", () => {
  test("[M8] should_record_each_script_once_and_skip_it_on_the_next_run", async () => {
    const history = await db.collection("_schema_migrations").find().toArray();

    expect(history.map(({ _id }) => _id)).toEqual([
      "0001_venue_details",
      "0002_venue_calendar",
      "0003_venue_photos",
      "0004_equipment_details",
    ]);
    await expect(applyMigrations(db)).resolves.toEqual([]);
  });

  test("[6.4] should_reject_rule_bearing_or_unknown_fields_in_venue_details", async () => {
    await expect(db.collection("venue_details").insertOne(detail(900, { max_capacity: 500 })))
      .rejects.toMatchObject({ code: 121 });
  });

  test("[6.4] should_reject_oversized_fields_in_venue_details", async () => {
    await expect(db.collection("venue_details").insertOne(detail(901, { description: "x".repeat(2001) })))
      .rejects.toMatchObject({ code: 121 });
  });
});

describe("venueDetailModel.getVenueDetailsByIds", () => {
  beforeAll(async () => {
    await db.collection("venue_details").insertMany([detail(1), detail(2, { description: null })]);
  });

  test("[SPM-72-AC3] should_return_details_keyed_by_postgres_venue_id_for_numeric_ids", async () => {
    const details = await getVenueDetailsByIds([1, 2, 3]);

    expect([...details.keys()].sort()).toEqual(["1", "2"]);
    expect(details.get("1")).toEqual({
      _id: "1",
      description: "Quiet hall",
      facilities: ["Projector"],
      accessibilityFeatures: ["Step-free access"],
      supportedLayouts: ["THEATRE"],
      emergencyAccess: "North exit",
      knownRestrictions: [],
    });
    // Display-only copies are not read back.
    expect(details.get("1")).not.toHaveProperty("name");
    expect(details.has("3")).toBe(false);
  });

  test("[TC-VC-002] should_not_query_mongodb_when_there_are_no_venues", async () => {
    const uri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = "";
    try {
      await expect(getVenueDetailsByIds([])).resolves.toEqual(new Map());
    } finally {
      process.env.MONGODB_URI = uri;
    }
  });
});
