// SPM-179 live integration tests: venue booking requests through the real
// Express routes, Supabase Auth, the shared development database and the
// least-privilege venue lock connection (VENUE_LOCK_DATABASE_URL, Master 2.7.2,
// 7.4). MongoDB is a local in-memory replica set (Master M7). Fixtures are
// synthetic, namespaced by run ID and removed afterwards; notifications sent to
// Venue Staff belong to the fixture events and are removed with them.
//
// Skipped when VENUE_LOCK_DATABASE_URL is not set: the request route cannot run
// without the venue lock connection.
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { closeVenueLockPool } = require("../../config/venueLockDatabase");
const { applyMigrations } = require("../../mongodb/migrate");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { createLifecycleEvent } = require("../fixtures/lifecycleFixtures");

jest.setTimeout(180000);

const describeLive = process.env.VENUE_LOCK_DATABASE_URL ? describe : describe.skip;

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const runId = newRunId();
const prefix = `spm179-${runId}`;
let fixtures;
let mongoServer;
let eventId;
let otherEvent;
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
const post = async (key, targetEventId, bookings, idempotencyKey = nextKey()) =>
  as(key, request(app).post(`/api/events/${targetEventId}/venue-bookings`).set("Idempotency-Key", idempotencyKey).send({ bookings }));
const list = async (key, targetEventId = eventId) => as(key, request(app).get(`/api/events/${targetEventId}/venue-bookings`));

const item = (venue, overrides = {}) => ({
  venueId: venue.venueId,
  label: `${prefix} ${venue.label}`,
  start: AT("10:00"),
  end: AT("11:00"),
  expectedAttendance: 50,
  layout: "Theatre",
  ...overrides,
});

const remember = (response) => {
  if (response.status < 300) recordFixtureIds(runId, "bookingIds", response.body.bookings.map((booking) => booking.bookingId));
  return response;
};

const insertVenue = async (label, row, { withRoom = true } = {}) => {
  const { data, error } = await supabase.from("venue")
    .insert({ name: `${prefix} ${label}`, address: `${prefix} ${label} Road`, operating_hours: "08:00-22:00", ...row })
    .select("venue_id").single();
  if (error) throw new Error(`Fixture venue ${label} failed: ${error.message}`);
  recordFixtureIds(runId, "venueIds", [data.venue_id]);
  if (withRoom) {
    const { data: room, error: roomError } = await supabase.from("room")
      .insert({ venue_id: data.venue_id, layout_type: "THEATRE", capacity: row.max_capacity })
      .select("room_id").single();
    if (roomError) throw new Error(`Fixture room ${label} failed: ${roomError.message}`);
    recordFixtureIds(runId, "roomIds", [room.room_id]);
  }
  return { venueId: data.venue_id, label };
};

const details = (venueId) => ({
  _id: String(venueId),
  pg_version: 1,
  name: `${prefix} venue`,
  location: `${prefix} road`,
  facilities: ["Projector"],
  accessibilityFeatures: [],
  supportedLayouts: ["Theatre"],
  setupMinutes: 30,
  turnaroundMinutes: 45,
  version: 1,
});

const bookingRows = async (targetEventId) => {
  const { data, error } = await supabase.from("venue_booking")
    .select("booking_id,venue_id,room_id,status,is_primary,occupied_range,requested_by")
    .eq("event_id", targetEventId).order("booking_id");
  if (error) throw error;
  return data;
};
// Notices the fixture Venue Staff member received for one event.
const venueStaffNotices = async (targetEventId) => {
  const { count, error } = await supabase.from("notification_recipient")
    .select("notification_id, notification!inner(event_id)", { count: "exact", head: true })
    .eq("recipient_id", fixtures.accounts.venueStaff.userId)
    .eq("notification.event_id", targetEventId);
  if (error) throw error;
  return count;
};
const arrangementVersion = async (targetEventId) => {
  const { data, error } = await supabase.from("event").select("arrangement_version").eq("event_id", targetEventId).single();
  if (error) throw error;
  return data.arrangement_version;
};

describeLive("SPM-179 venue booking requests (live)", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = `spm179_${runId}`;

    fixtures = await createAuthFixtures(runId);
    // Assigned to "coordinator" by "coordinatorLead", who supervises it.
    eventId = fixtures.events.reassignable;
    // A second planning event at the same time for another coordinator (TC-18);
    // coordinatorTwo is already busy then in the shared fixtures.
    otherEvent = await createLifecycleEvent(fixtures, {
      coordinator_id: fixtures.accounts.coordinatorThree.userId, start_datetime: AT("10:00"), end_datetime: AT("12:00"),
    });

    venues.hall = await insertVenue("Hall", { max_capacity: 200 });
    venues.annex = await insertVenue("Annex", { max_capacity: 80 });
    venues.blocked = await insertVenue("Blocked", { max_capacity: 200 });
    venues.roomless = await insertVenue("Roomless", { max_capacity: 120 }, { withRoom: false });

    const db = await getMongoDb();
    await applyMigrations(db);
    await db.collection("venue_details").insertMany(Object.values(venues).map((venue) => details(venue.venueId)));
    // An operational block 09:00–13:00 at the blocked venue (TC-11).
    await db.collection("venue_calendar").insertOne({
      venueId: String(venues.blocked.venueId),
      type: "BLOCK",
      status: "ACTIVE",
      start: new Date(AT("09:00")),
      end: new Date(AT("13:00")),
      occupiedStart: new Date(AT("09:00")),
      occupiedEnd: new Date(AT("13:00")),
      eventId: null,
      reason: "MAINTENANCE",
      note: null,
      createdBy: fixtures.accounts.venueStaff.userId,
      createdAt: new Date(),
      version: 1,
    });
  });

  afterAll(async () => {
    try {
      if (venues.roomless) {
        const { data } = await supabase.from("room").select("room_id").eq("venue_id", venues.roomless.venueId);
        recordFixtureIds(runId, "roomIds", (data || []).map((room) => room.room_id));
      }
      await cleanupAuthFixtures(runId);
    } finally {
      await closeVenueLockPool();
      await closeMongoDb();
      if (mongoServer) await mongoServer.stop();
      process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
      process.env.MONGODB_DB_NAME = ORIGINAL_MONGODB_DB_NAME;
    }
  });

  test("[SPM-179-TC-01][AC11][AC12] one venue is saved pending and primary, with version, activity and one Venue Staff notice", async () => {
    const before = await arrangementVersion(eventId);
    const response = remember(await post("coordinator", eventId, [item(venues.hall, { expectedAttendance: 150 })]));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ eventId, requestId: expect.stringMatching(/^REQ-\d{6}$/), replayed: false });
    const [saved] = response.body.bookings;
    expect(saved).toMatchObject({
      venueId: venues.hall.venueId, status: "PENDING", statusLabel: "Pending", isPrimary: true,
      occupiedStart: expect.stringMatching(/^2027-03-10T09:30/), occupiedEnd: expect.stringMatching(/^2027-03-10T11:45/),
    });

    const [row] = await bookingRows(eventId);
    expect(row).toMatchObject({ booking_id: saved.bookingId, venue_id: venues.hall.venueId, status: "PENDING", is_primary: true, requested_by: fixtures.accounts.coordinator.userId });
    expect(row.room_id).toEqual(expect.any(Number));
    expect(row.occupied_range).toBeTruthy();
    expect(await arrangementVersion(eventId)).toBe(before + 1);

    const { count: activity } = await supabase.from("activity_log").select("log_id", { count: "exact", head: true })
      .eq("entity_name", "event").eq("entity_id", eventId).eq("action", "VENUE_BOOKINGS_REQUESTED");
    expect(activity).toBe(1);
    expect(await venueStaffNotices(eventId)).toBe(1);
  });

  test("[SPM-179-TC-17][AC13] a replay returns the stored result; the same key with another body is refused", async () => {
    const key = nextKey();
    const first = remember(await post("coordinator", eventId, [item(venues.annex, { start: AT("11:00"), end: AT("12:00") })], key));
    expect(first.status).toBe(201);
    const replay = await post("coordinator", eventId, [item(venues.annex, { start: AT("11:00"), end: AT("12:00") })], key);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.bookings.map((booking) => booking.bookingId)).toEqual(first.body.bookings.map((booking) => booking.bookingId));
    // The event already had a primary venue, so the new one is additional (AC10, TC-15).
    expect(first.body.bookings[0].isPrimary).toBe(false);

    const reused = await post("coordinator", eventId, [item(venues.annex, { expectedAttendance: 60 })], key);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await venueStaffNotices(eventId)).toBe(2);
  });

  test("[SPM-179-TC-07][TC-08][AC6][AC4] capacity and a second booking at the same venue are refused against that section, saving nothing", async () => {
    const before = (await bookingRows(eventId)).length;
    const capacity = await post("coordinatorThree", otherEvent.event_id, [item(venues.annex, { expectedAttendance: 81 })]);
    expect(capacity.status).toBe(409);
    expect(capacity.body).toMatchObject({ code: "VENUE_CAPACITY_EXCEEDED", bookingIndex: 0 });
    expect(capacity.body.fields["bookings.0.expectedAttendance"]).toBe("Expected attendance (81) exceeds this venue's capacity (80).");

    const again = await post("coordinator", eventId, [item(venues.hall, { start: AT("11:00"), end: AT("12:00") })]);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("VENUE_ALREADY_BOOKED_FOR_EVENT");
    expect((await bookingRows(eventId)).length).toBe(before);
  });

  test("[SPM-179-TC-11][AC7] an active block names the conflicting period", async () => {
    const response = await post("coordinatorThree", otherEvent.event_id, [item(venues.blocked)]);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("BOOKING_CONFLICT");
    expect(response.body.conflicts).toEqual([expect.objectContaining({ type: "BLOCK" })]);
    expect(response.body.fields["bookings.0.start"]).toMatch(/operational block/);
  });

  test("[SPM-179-TC-18][AC14] simultaneous overlapping requests for one venue: exactly one is saved", async () => {
    const roomless = venues.roomless;
    const [one, two] = await Promise.all([
      post("coordinator", eventId, [item(roomless, { start: AT("10:00"), end: AT("11:00") })]),
      post("coordinatorThree", otherEvent.event_id, [item(roomless, { start: AT("10:30"), end: AT("11:30") })]),
    ]);
    remember(one);
    remember(two);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([201, 409]);
    const refused = one.status === 409 ? one : two;
    expect(refused.body.code).toBe("BOOKING_CONFLICT");
    const { count } = await supabase.from("venue_booking").select("booking_id", { count: "exact", head: true })
      .eq("venue_id", roomless.venueId).in("status", ["PENDING", "APPROVED"]);
    expect(count).toBe(1);
  });

  test("[SPM-179-TC-21] a venue without a room gets one, and Venue Staff can see and approve the booking", async () => {
    const { data: rooms } = await supabase.from("room").select("room_id,capacity").eq("venue_id", venues.roomless.venueId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].capacity).toBe(120);
    const { data: saved } = await supabase.from("venue_booking").select("booking_id,event_id,room_id")
      .eq("venue_id", venues.roomless.venueId).eq("status", "PENDING").single();
    expect(saved.room_id).toBe(rooms[0].room_id);

    const staffView = await as("venueStaff", request(app).get(`/api/venues/bookings/events/${saved.event_id}`));
    expect(staffView.status).toBe(200);
    expect(staffView.body.bookings.map((booking) => booking.bookingId)).toContain(saved.booking_id);

    const { data: decision, error } = await supabase.rpc("decide_venue_booking", {
      p_actor_id: fixtures.accounts.venueStaff.userId,
      p_booking_id: saved.booking_id,
      p_decision: "APPROVE",
      p_expected_status: "PENDING",
      p_reason: null,
      p_setup_minutes: 30,
      p_turnaround_minutes: 45,
    });
    expect(error).toBeNull();
    expect(decision).toBeTruthy();
    const { data: approved } = await supabase.from("venue_booking").select("status").eq("booking_id", saved.booking_id).single();
    expect(approved.status).toBe("APPROVED");
  });

  test("[SPM-179-TC-19][AC1] access: other coordinators get 404; the Lead and the owner cannot request; the Lead reads the list", async () => {
    const stranger = await post("coordinatorTwo", eventId, [item(venues.annex)]);
    expect(stranger.status).toBe(404);
    const lead = await post("coordinatorLead", eventId, [item(venues.annex)]);
    expect(lead.status).toBe(403);
    const owner = await post("organiserA", eventId, [item(venues.annex)]);
    expect(owner.status).toBe(403);

    const leadList = await list("coordinatorLead");
    expect(leadList.status).toBe(200);
    expect(leadList.body.canRequestVenueBookings).toBe(false);
    expect(leadList.body.bookings.length).toBeGreaterThan(0);
    expect((await list("coordinatorTwo")).status).toBe(404);
  });

  test("[SPM-179-AC12] the coordinator's list shows each booking with its status and the primary venue", async () => {
    const response = await list("coordinator");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ eventId, canRequestVenueBookings: true });
    const hall = response.body.bookings.find((booking) => booking.venueId === venues.hall.venueId);
    expect(hall).toMatchObject({ venueName: `${prefix} Hall`, status: "PENDING", statusLabel: "Pending", isPrimary: true });
    expect(hall.occupiedStart).toMatch(/^2027-03-10T09:30/);
    expect(response.body.bookings.filter((booking) => booking.isPrimary)).toHaveLength(1);
  });
});
