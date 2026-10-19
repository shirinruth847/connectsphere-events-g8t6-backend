// SPM-72 live integration tests: real Express routes, middleware, Supabase Auth
// and the shared development database from .env. MongoDB is a local in-memory
// server (Master M7), never Atlas, so results do not depend on the developer's
// MONGODB_URI. Users sign in directly with Supabase Auth, as the browser does,
// and the resulting token is sent to the backend. Fixtures are synthetic,
// namespaced by run ID and removed afterwards.
//
// TC-VC-002 (no available venues) cannot run here: the shared database always
// holds other active venues. It is covered by tests/unit/venueModel.test.js,
// tests/unit/venueCatalogue.test.js and the frontend venue-catalogue journey.
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { applyMigrations } = require("../../mongodb/migrate");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const {
  newRunId,
  createAuthFixtures,
  cleanupAuthFixtures,
  recordFixtureIds,
} = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const runId = newRunId();
const venueName = (label) => `spm72-${runId} Venue ${label}`;
let fixtures;
let mongoServer;
const venues = {};
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) {
        throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      }
      return session;
    }));
  }
  return sessions.get(key);
};

const bearer = (session) => `Bearer ${session.access_token}`;
const getCatalogue = async (key = "coordinator") =>
  request(app).get("/api/venues").set("Authorization", bearer(await signIn(key)));

const insertVenue = async (label, row) => {
  const { data: venue, error } = await supabase
    .from("venue")
    .insert({ name: venueName(label), ...row })
    .select("venue_id")
    .single();
  if (error) throw new Error(`Fixture venue ${label} failed: ${error.message}`);
  recordFixtureIds(runId, "venueIds", [venue.venue_id]);
  return venue.venue_id;
};

const insertRoom = async (venueId, layoutType, capacity) => {
  const { data: room, error } = await supabase
    .from("room")
    .insert({ venue_id: venueId, layout_type: layoutType, capacity })
    .select("room_id")
    .single();
  if (error) throw new Error(`Fixture room failed: ${error.message}`);
  recordFixtureIds(runId, "roomIds", [room.room_id]);
};

const READ_ROLES = ["coordinator", "coordinatorLead", "venueStaff"];
const DENIED_ROLES = ["organiserA", "attendee", "techSupport"];

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.MONGODB_DB_NAME = `spm72_${runId}`;

  fixtures = await createAuthFixtures(runId);

  venues.A = await insertVenue("A", {
    address: `spm72-${runId} 1 Alpha Road`,
    max_capacity: 120,
    operating_hours: "09:00-18:00",
    accessibility_features: "Ramp at main entrance",
    setup_turnaround_min: 20,
  });
  await insertRoom(venues.A, "THEATRE", 120);
  await insertRoom(venues.A, "CLASSROOM", 60);
  venues.B = await insertVenue("B", {
    address: `spm72-${runId} 2 Beta Road`,
    max_capacity: 80,
    operating_hours: "08:00-22:00",
  });

  const db = await getMongoDb();
  await applyMigrations(db);
  await db.collection("venue_details").insertOne({
    _id: String(venues.A),
    pg_version: 1,
    name: venueName("A"),
    location: `spm72-${runId} 1 Alpha Road`,
    description: "Synthetic hall for SPM-72",
    facilities: ["Projector", "PA system"],
    accessibilityFeatures: ["Step-free access", "Hearing loop"],
    supportedLayouts: ["THEATRE", "CLASSROOM"],
    emergencyAccess: "Two exits on the north side",
    knownRestrictions: ["No open flames"],
  });
});

afterAll(async () => {
  try {
    await cleanupAuthFixtures(runId);
  } finally {
    await closeMongoDb();
    if (mongoServer) await mongoServer.stop();
    process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
    process.env.MONGODB_DB_NAME = ORIGINAL_MONGODB_DB_NAME;
  }
});

describe("GET /api/venues (SPM-72)", () => {
  test.each([undefined, "", "Basic token", "Bearer"])(
    "[TC-AUTH-001] should_return_401_when_authorization_is_%p",
    async (authorization) => {
      const requestBuilder = request(app).get("/api/venues");
      if (authorization !== undefined) requestBuilder.set("Authorization", authorization);
      const response = await requestBuilder;
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("UNAUTHENTICATED");
    }
  );

  test.each(READ_ROLES)("[SPM-72-AC1] should_return_200_for_%s", async (key) => {
    const response = await getCatalogue(key);
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.venues)).toBe(true);
    expect(response.body.detailsAvailable).toBe(true);
  });

  test.each(DENIED_ROLES)("[SPM-72-AC1] should_return_403_for_%s", async (key) => {
    const response = await getCatalogue(key);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });

  test("[SPM-72-AC1] should_not_accept_a_venue_write_from_a_coordinator", async () => {
    const session = await signIn("coordinator");
    const response = await request(app)
      .post("/api/venues")
      .set("Authorization", bearer(session))
      .send({ name: venueName("not created"), address: "x", max_capacity: 1 });
    expect(response.status).toBe(404);

    const { count } = await supabase.from("venue").select("venue_id", { count: "exact", head: true }).eq("name", venueName("not created"));
    expect(count).toBe(0);
  });

  test("[TC-VC-001][SPM-72-AC2][SPM-72-AC3] should_display_venue_a_and_venue_b_with_their_details", async () => {
    const response = await getCatalogue();
    expect(response.status).toBe(200);

    const names = response.body.venues.map(({ name }) => name);
    expect(names.indexOf(venueName("A"))).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(venueName("A"))).toBeLessThan(names.indexOf(venueName("B")));

    const venueA = response.body.venues.find(({ venueId }) => venueId === venues.A);
    expect(venueA).toEqual({
      venueId: venues.A,
      name: venueName("A"),
      address: `spm72-${runId} 1 Alpha Road`,
      maxCapacity: 120,
      operatingHours: "09:00-18:00",
      accessibilityFeatures: ["Step-free access", "Hearing loop"],
      setupTurnaroundMinutes: 20,
      rooms: expect.arrayContaining([
        { roomId: expect.any(Number), layoutType: "THEATRE", capacity: 120 },
        { roomId: expect.any(Number), layoutType: "CLASSROOM", capacity: 60 },
      ]),
      detailStatus: "CURRENT",
      description: "Synthetic hall for SPM-72",
      facilities: ["Projector", "PA system"],
      supportedLayouts: ["THEATRE", "CLASSROOM"],
      emergencyAccess: "Two exits on the north side",
      knownRestrictions: ["No open flames"],
    });
    expect(venueA.rooms).toHaveLength(2);

    const venueB = response.body.venues.find(({ venueId }) => venueId === venues.B);
    expect(venueB).toEqual(expect.objectContaining({
      name: venueName("B"),
      maxCapacity: 80,
      operatingHours: "08:00-22:00",
      rooms: [],
      accessibilityFeatures: null,
      detailStatus: "NOT_AVAILABLE",
      description: null,
      facilities: null,
    }));
  });

  test("[M4] should_return_postgres_details_marked_not_checked_when_mongodb_is_unavailable", async () => {
    const uri = process.env.MONGODB_URI;
    process.env.MONGODB_URI = "";
    let response;
    try {
      response = await getCatalogue();
    } finally {
      process.env.MONGODB_URI = uri;
    }

    expect(response.status).toBe(200);
    expect(response.body.detailsAvailable).toBe(false);
    const venueA = response.body.venues.find(({ venueId }) => venueId === venues.A);
    expect(venueA).toEqual(expect.objectContaining({
      maxCapacity: 120,
      accessibilityFeatures: ["Ramp at main entrance"],
      detailStatus: "NOT_CHECKED",
      description: null,
      facilities: null,
      supportedLayouts: null,
      emergencyAccess: null,
      knownRestrictions: null,
    }));
    expect(venueA.rooms).toHaveLength(2);
    response.body.venues.forEach((venue) => expect(venue.detailStatus).toBe("NOT_CHECKED"));
  });

  // Runs after TC-VC-001 on purpose: it deletes Venue A, as SPM-210 will.
  test("[TC-VC-003][SPM-72-AC4] should_display_venue_b_and_not_venue_a_once_venue_a_is_deleted", async () => {
    const { error } = await supabase.from("venue").update({ is_active: false }).eq("venue_id", venues.A);
    expect(error).toBeNull();

    const response = await getCatalogue();
    expect(response.status).toBe(200);

    const ids = response.body.venues.map(({ venueId }) => venueId);
    expect(ids).toContain(venues.B);
    expect(ids).not.toContain(venues.A);
    expect(response.body.venues.some(({ name }) => name === venueName("A"))).toBe(false);
  });
});
