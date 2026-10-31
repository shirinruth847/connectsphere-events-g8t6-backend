// SPM-195 live integration tests: venue blocks, incidents and restoration
// through the real Express routes, Supabase Auth, the shared development
// database and the venue lock connection (VENUE_LOCK_DATABASE_URL, Master 7.4).
// MongoDB is a local in-memory replica set (Master M7). Fixtures are synthetic
// and namespaced by run ID; incidents are removed through the privileged test
// connection before the shared cleanup, because they block booking deletion.
//
// Skipped unless VENUE_LOCK_DATABASE_URL and TEST_DATABASE_URL are set.
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { closeVenueLockPool } = require("../../config/venueLockDatabase");
const { applyMigrations } = require("../../mongodb/migrate");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { createLifecycleEvent, cleanupLifecycleRows } = require("../fixtures/lifecycleFixtures");

jest.setTimeout(180000);

const describeLive = process.env.VENUE_LOCK_DATABASE_URL && process.env.TEST_DATABASE_URL ? describe : describe.skip;

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const runId = newRunId();
const prefix = `spm195-${runId}`;
let fixtures;
let mongoServer;
let eventId;
let raceEvent;
const venues = {};
const sessions = new Map();

// The fixture event runs 2027-03-10 10:00–12:00 UTC (authFixtures "reassignable").
const AT = (time) => `2027-03-10T${time}:00.000Z`;

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed: ${error ? error.code : "no session"}`);
      return session;
    }));
  }
  return sessions.get(key);
};
const as = async (key, req) => req.set("Authorization", `Bearer ${(await signIn(key)).access_token}`);
let keyCounter = 0;
const nextKey = () => `${prefix}-key-${++keyCounter}`;

// The fixture event belongs to "coordinator"; the race event to "coordinatorThree".
const requestBooking = async (targetEventId, venue, start, end) => {
  const account = targetEventId === eventId ? "coordinator" : "coordinatorThree";
  const response = await as(account, request(app)
    .post(`/api/events/${targetEventId}/venue-bookings`).set("Idempotency-Key", nextKey())
    .send({ bookings: [{ venueId: venue.venueId, label: `${prefix} booking`, start, end, expectedAttendance: 50, layout: "Theatre" }] }));
  if (response.status < 300) recordFixtureIds(runId, "bookingIds", response.body.bookings.map((booking) => booking.bookingId));
  return response;
};
const postBlock = async (venue, body, key = nextKey(), account = "venueStaff") =>
  as(account, request(app).post(`/api/venues/${venue.venueId}/blocks`).set("Idempotency-Key", key).send(body));
const blockBody = (start, end) => ({ reason: "MAINTENANCE", start, end, note: `${prefix} air conditioning repair` });

const insertVenue = async (label, maxCapacity) => {
  const { data, error } = await supabase.from("venue")
    .insert({ name: `${prefix} ${label}`, address: `${prefix} ${label} Road`, operating_hours: "08:00-22:00", max_capacity: maxCapacity })
    .select("venue_id").single();
  if (error) throw new Error(`Fixture venue ${label} failed: ${error.message}`);
  recordFixtureIds(runId, "venueIds", [data.venue_id]);
  const { data: room, error: roomError } = await supabase.from("room")
    .insert({ venue_id: data.venue_id, layout_type: "THEATRE", capacity: maxCapacity })
    .select("room_id").single();
  if (roomError) throw new Error(`Fixture room ${label} failed: ${roomError.message}`);
  recordFixtureIds(runId, "roomIds", [room.room_id]);
  return { venueId: data.venue_id, label };
};

const incidentsOf = async (targetEventId) => {
  const { data, error } = await supabase.from("resource_incidents")
    .select("incident_id,booking_id,calendar_block_id,status,resolution").eq("event_id", targetEventId).order("incident_id");
  if (error) throw error;
  return data;
};
const arrangementVersion = async (targetEventId) => {
  const { data, error } = await supabase.from("event").select("arrangement_version,status").eq("event_id", targetEventId).single();
  if (error) throw error;
  return data;
};
const noticeTitles = async (targetEventId) => {
  const { data, error } = await supabase.from("notification").select("title").eq("event_id", targetEventId);
  if (error) throw error;
  return data.map((row) => row.title);
};

describeLive("SPM-195 venue blocks (live)", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = `spm195_${runId}`;

    fixtures = await createAuthFixtures(runId);
    eventId = fixtures.events.reassignable;
    raceEvent = (await createLifecycleEvent(fixtures, {
      coordinator_id: fixtures.accounts.coordinatorThree.userId, start_datetime: AT("10:00"), end_datetime: AT("12:00"),
    })).event_id;

    venues.hall = await insertVenue("Hall", 200);
    venues.annex = await insertVenue("Annex", 80);
    venues.race = await insertVenue("Race", 80);

    const db = await getMongoDb();
    await applyMigrations(db);
    await db.collection("venue_details").insertMany(Object.values(venues).map((venue) => ({
      _id: String(venue.venueId), pg_version: 1, name: `${prefix} venue`, location: `${prefix} road`,
      facilities: [], accessibilityFeatures: [], supportedLayouts: ["Theatre"],
      setupMinutes: 30, turnaroundMinutes: 0, version: 1,
    })));
  });

  afterAll(async () => {
    try {
      if (fixtures) {
        const manifestEvents = [...Object.values(fixtures.events), raceEvent].filter(Number.isInteger);
        await cleanupLifecycleRows(runId, manifestEvents);
        await cleanupAuthFixtures(runId);
      }
    } finally {
      await closeVenueLockPool();
      await closeMongoDb();
      if (mongoServer) await mongoServer.stop();
      process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
      process.env.MONGODB_DB_NAME = ORIGINAL_MONGODB_DB_NAME;
    }
  });

  test("[SPM-195-TC-01] a block on a free venue is saved with no incidents", async () => {
    const response = await postBlock(venues.annex, blockBody(AT("13:00"), AT("15:00")));
    expect(response.status).toBe(201);
    expect(response.body.block).toMatchObject({ status: "ACTIVE", reason: "MAINTENANCE", reasonLabel: "Maintenance", version: 1 });
    expect(response.body.incidents).toEqual([]);
    const listed = await as("venueStaff", request(app).get(`/api/venues/${venues.annex.venueId}/blocks`));
    expect(listed.status).toBe(200);
    expect(listed.body.blocks.map((block) => block.blockId)).toContain(response.body.block.blockId);
  });

  test("[SPM-195-TC-03] other roles are refused", async () => {
    const response = await postBlock(venues.annex, blockBody(AT("16:00"), AT("17:00")), nextKey(), "coordinator");
    expect(response.status).toBe(403);
  });

  test("[SPM-195-TC-04][TC-09][TC-10][TC-12][TC-11] block, card, shorten, restore", async () => {
    // Booking 10:00–11:00 with 30 minutes of setup occupies 09:30–11:00.
    const booked = await requestBooking(eventId, venues.hall, AT("10:00"), AT("11:00"));
    expect(booked.status).toBe(201);
    const [{ bookingId }] = booked.body.bookings;
    const before = await arrangementVersion(eventId);

    const blocked = await postBlock(venues.hall, blockBody(AT("09:00"), AT("10:00")));
    expect(blocked.status).toBe(201);
    expect(blocked.body.incidents).toEqual([expect.objectContaining({ eventId, bookingId })]);
    const [incident] = await incidentsOf(eventId);
    expect(incident).toMatchObject({ booking_id: bookingId, status: "OPEN" });
    expect((await arrangementVersion(eventId)).arrangement_version).toBe(before.arrangement_version + 1);
    expect(await noticeTitles(eventId)).toEqual(expect.arrayContaining(["Alternative venue required", "Venue arrangement affected"]));

    const card = await as("coordinator", request(app).get(`/api/events/${eventId}/venue-bookings`));
    expect(card.status).toBe(200);
    const affected = card.body.bookings.find((booking) => booking.bookingId === bookingId);
    expect(affected.incident).toMatchObject({
      status: "OPEN", canBeRestored: false, block: expect.objectContaining({ reasonLabel: "Maintenance", note: blockBody().note }),
    });

    const stillBlocked = await as("venueStaff", request(app).post(`/api/venues/incidents/${incident.incident_id}/restore`)
      .set("Idempotency-Key", nextKey()));
    expect(stillBlocked.status).toBe(409);
    expect(stillBlocked.body.code).toBe("INCIDENT_STILL_BLOCKED");

    const longer = await as("venueStaff", request(app).put(`/api/venues/${venues.hall.venueId}/blocks/${blocked.body.block.blockId}`)
      .send({ start: AT("09:00"), end: AT("11:00"), version: 1 }));
    expect(longer.status).toBe(409);
    expect(longer.body.error).toBe("Record a new block for additional time.");

    const shortened = await as("venueStaff", request(app).put(`/api/venues/${venues.hall.venueId}/blocks/${blocked.body.block.blockId}`)
      .send({ start: AT("09:00"), end: AT("09:30"), version: 1 }));
    expect(shortened.status).toBe(200);
    expect(shortened.body.incidents[0]).toMatchObject({ status: "OPEN", canBeRestored: true, restoreLabel: "Can be restored" });
    expect(await noticeTitles(eventId)).toContain("Venue block shortened");

    const key = nextKey();
    const restored = await as("venueStaff", request(app).post(`/api/venues/incidents/${incident.incident_id}/restore`).set("Idempotency-Key", key));
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ status: "RESOLVED", resolution: "RESTORED", changed: true });
    const after = await arrangementVersion(eventId);
    expect(after.arrangement_version).toBe(before.arrangement_version + 2);
    expect(after.status).toBe(before.status);
    expect(await noticeTitles(eventId)).toContain("Venue available again");

    const repeat = await as("venueStaff", request(app).post(`/api/venues/incidents/${incident.incident_id}/restore`).set("Idempotency-Key", nextKey()));
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ status: "RESOLVED", changed: false });
  });

  test("[SPM-195-TC-17] a retried block gives one block and one set of incidents", async () => {
    const key = nextKey();
    const first = await postBlock(venues.hall, blockBody(AT("10:30"), AT("10:45")), key);
    const second = await postBlock(venues.hall, blockBody(AT("10:30"), AT("10:45")), key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.block.blockId).toBe(first.body.block.blockId);
    const forBlock = (await incidentsOf(eventId)).filter((row) => row.calendar_block_id === first.body.block.blockId);
    expect(forBlock).toHaveLength(1);
  });

  test("[SPM-195-TC-16][AC12] a simultaneous booking and block never leave a saved booking without an incident", async () => {
    const [booking, block] = await Promise.all([
      requestBooking(raceEvent, venues.race, AT("10:00"), AT("11:00")),
      postBlock(venues.race, blockBody(AT("09:00"), AT("13:00"))),
    ]);
    const outcomes = [`${booking.status} ${booking.body.code ?? ""}`.trim(), `${block.status} ${block.body.code ?? ""}`.trim()];
    expect(outcomes.filter((outcome) => !/^(200|201|409)\b/.test(outcome))).toEqual([]);
    if (booking.status === 201 && block.status === 201) {
      expect(block.body.incidents).toEqual([expect.objectContaining({ eventId: raceEvent, bookingId: booking.body.bookings[0].bookingId })]);
    }
    if (booking.status === 409) {
      expect(["BOOKING_CONFLICT", "VENUE_LOCK_TIMEOUT"]).toContain(booking.body.code);
      if (booking.body.code === "BOOKING_CONFLICT") expect(block.status).toBe(201);
    }
    if (block.status === 409) expect(block.body.code).toBe("VENUE_LOCK_TIMEOUT");
  });
});
