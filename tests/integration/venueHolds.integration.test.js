// SPM-190 live integration tests: tentative venue holds through the real
// Express routes, Supabase Auth, the shared development database and the venue
// lock connection (VENUE_LOCK_DATABASE_URL, Master 7.4). MongoDB is a local
// in-memory replica set (Master M7). Fixtures are synthetic and namespaced by
// run ID; hold requests are removed through the privileged test connection
// before the shared cleanup, because they block event and venue deletion.
//
// Skipped unless VENUE_LOCK_DATABASE_URL and TEST_DATABASE_URL are set.
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { ObjectId } = require("mongodb");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { closeVenueLockPool } = require("../../config/venueLockDatabase");
const { applyMigrations } = require("../../mongodb/migrate");
const venueModel = require("../../model/venueModel");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { createLifecycleEvent, cleanupLifecycleRows, withPrivilegedDb } = require("../fixtures/lifecycleFixtures");

jest.setTimeout(180000);

const describeLive = process.env.VENUE_LOCK_DATABASE_URL && process.env.TEST_DATABASE_URL ? describe : describe.skip;

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const DAY_MS = 24 * 60 * 60 * 1000;
const runId = newRunId();
const prefix = `spm190-${runId}`;
let fixtures;
let mongoServer;
let eventId;
let raceEvent;
const venues = {};
const sessions = new Map();

// The fixture event runs 2027-03-10 10:00–12:00 UTC (authFixtures "reassignable"),
// far enough ahead that a hold lasts the full 7 days.
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
const ownerOf = (targetEventId) => (targetEventId === eventId ? "coordinator" : "coordinatorThree");
const holdBody = (venue, start, end) => ({ venueId: venue.venueId, label: `${prefix} hold`, start, end, expectedAttendance: 50, note: `${prefix} note` });
const requestHold = async (targetEventId, venue, start, end, key = nextKey(), account = ownerOf(targetEventId)) =>
  as(account, request(app).post(`/api/events/${targetEventId}/venue-holds`).set("Idempotency-Key", key).send(holdBody(venue, start, end)));
const placeHold = async (requestId, key = nextKey()) =>
  as("venueStaff", request(app).post(`/api/venues/hold-requests/${requestId}/place`).set("Idempotency-Key", key));

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

const calendarEntry = async (holdId) => (await getMongoDb()).collection("venue_calendar").findOne({ _id: new ObjectId(holdId) });
const noticeTitles = async (targetEventId) => {
  const { data, error } = await supabase.from("notification").select("title").eq("event_id", targetEventId);
  if (error) throw error;
  return data.map((row) => row.title);
};
const holdRows = async (targetEventId) => {
  const { data, error } = await supabase.from("venue_hold_request")
    .select("hold_request_id,status,calendar_hold_id").eq("event_id", targetEventId);
  if (error) throw error;
  return data;
};

describeLive("SPM-190 tentative venue holds (live)", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = `spm190_${runId}`;

    fixtures = await createAuthFixtures(runId);
    eventId = fixtures.events.reassignable;
    raceEvent = (await createLifecycleEvent(fixtures, {
      coordinator_id: fixtures.accounts.coordinatorThree.userId, start_datetime: AT("10:00"), end_datetime: AT("12:00"),
    })).event_id;

    venues.hall = await insertVenue("Hall", 200);
    venues.annex = await insertVenue("Annex", 80);
    venues.race = await insertVenue("Race", 80);
    venues.noBuffers = await insertVenue("NoBuffers", 80);

    const db = await getMongoDb();
    await applyMigrations(db);
    await db.collection("venue_details").insertMany([venues.hall, venues.annex, venues.race].map((venue) => ({
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

  test("[SPM-190-TC-01] the coordinator's request is pending, retries are safe and a second pending request is refused", async () => {
    const key = nextKey();
    const first = await requestHold(eventId, venues.annex, AT("10:00"), AT("11:00"), key);
    expect(first.status).toBe(201);
    expect(first.body.holdRequest).toMatchObject({ eventId, venueId: venues.annex.venueId, status: "PENDING", hold: null });

    const retry = await requestHold(eventId, venues.annex, AT("10:00"), AT("11:00"), key);
    expect(retry.status).toBeLessThan(300);
    expect(retry.body.holdRequest.holdRequestId).toBe(first.body.holdRequest.holdRequestId);

    const second = await requestHold(eventId, venues.annex, AT("11:00"), AT("12:00"));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("HOLD_REQUEST_EXISTS");
    expect((await holdRows(eventId)).filter((row) => row.status === "PENDING")).toHaveLength(1);
    expect(await noticeTitles(eventId)).toContain("Hold requested");

    const listed = await as("coordinator", request(app).get(`/api/events/${eventId}/venue-holds`));
    expect(listed.status).toBe(200);
    expect(listed.body.holds.map((hold) => hold.holdRequestId)).toContain(first.body.holdRequest.holdRequestId);
  });

  test("[SPM-190-TC-02] only the assigned coordinator may request, and only inside the event", async () => {
    // Another coordinator cannot see the event at all, so it is not found.
    const otherCoordinator = await requestHold(eventId, venues.hall, AT("10:00"), AT("11:00"), nextKey(), "coordinatorThree");
    expect(otherCoordinator.status).toBe(404);
    const staff = await requestHold(eventId, venues.hall, AT("10:00"), AT("11:00"), nextKey(), "venueStaff");
    expect(staff.status).toBe(404);
    const outside = await requestHold(eventId, venues.hall, AT("11:00"), AT("13:00"));
    expect(outside.status).toBe(400);
    expect(outside.body.fields).toHaveProperty("start");
  });

  test("[SPM-190-TC-03] Venue Staff see the pending request with its checks and expiry, then withdraw and decline end it", async () => {
    const listed = await as("venueStaff", request(app).get("/api/venues/hold-requests?status=PENDING"));
    expect(listed.status).toBe(200);
    const pending = listed.body.requests.find((row) => row.eventId === eventId && row.venueId === venues.annex.venueId);
    expect(pending.preview).toMatchObject({ blocking: [] });
    const expiresIn = new Date(pending.preview.expiresAt).getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(7 * DAY_MS - 60000);
    expect(expiresIn).toBeLessThanOrEqual(7 * DAY_MS);

    const coordinatorList = await as("coordinator", request(app).get("/api/venues/hold-requests"));
    expect(coordinatorList.status).toBe(403);

    const notOwner = await as("coordinatorThree", request(app).post(`/api/venues/hold-requests/${pending.holdRequestId}/withdraw`));
    expect(notOwner.status).toBe(403);
    const withdrawn = await as("coordinator", request(app).post(`/api/venues/hold-requests/${pending.holdRequestId}/withdraw`));
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.holdRequest.status).toBe("WITHDRAWN");
    const late = await placeHold(pending.holdRequestId);
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: "HOLD_REQUEST_DECIDED", currentStatus: "WITHDRAWN" });

    const again = await requestHold(eventId, venues.annex, AT("10:00"), AT("11:00"));
    expect(again.status).toBe(201);
    const id = again.body.holdRequest.holdRequestId;
    const noReason = await as("venueStaff", request(app).post(`/api/venues/hold-requests/${id}/decline`).send({ reason: " " }));
    expect(noReason.status).toBe(400);
    const declined = await as("venueStaff", request(app).post(`/api/venues/hold-requests/${id}/decline`).send({ reason: "Annex is closed that week." }));
    expect(declined.status).toBe(200);
    expect(declined.body.holdRequest).toMatchObject({ status: "DECLINED", declineReason: "Annex is closed that week." });
    expect(await noticeTitles(eventId)).toContain("Hold request declined");
  });

  test("[SPM-190-TC-04] placing writes one MongoDB hold, a retry places nothing more, and the held venue refuses other events", async () => {
    const requested = await requestHold(eventId, venues.hall, AT("10:00"), AT("11:00"));
    expect(requested.status).toBe(201);
    const id = requested.body.holdRequest.holdRequestId;

    const key = nextKey();
    const placed = await placeHold(id, key);
    expect(placed.status).toBe(200);
    expect(placed.body.holdRequest).toMatchObject({ status: "PLACED", hold: expect.objectContaining({ status: "ACTIVE", extended: false }) });
    const { holdId } = placed.body.holdRequest.hold;
    const entry = await calendarEntry(holdId);
    expect(entry).toMatchObject({ type: "HOLD", status: "ACTIVE", venueId: String(venues.hall.venueId), eventId });
    expect(new Date(entry.occupiedStart).toISOString()).toBe(AT("09:30"));
    expect(await noticeTitles(eventId)).toContain("Venue on hold");

    const replay = await placeHold(id, key);
    expect(replay.status).toBe(200);
    expect(replay.body.holdRequest.hold.holdId).toBe(holdId);
    const db = await getMongoDb();
    expect(await db.collection("venue_calendar").countDocuments({ venueId: String(venues.hall.venueId), type: "HOLD" })).toBe(1);

    const otherKey = await placeHold(id);
    expect(otherKey.status).toBe(409);
    expect(otherKey.body.code).toBe("HOLD_REQUEST_DECIDED");

    const rival = await requestHold(raceEvent, venues.hall, AT("10:30"), AT("11:30"));
    expect(rival.status).toBe(201);
    const refused = await placeHold(rival.body.holdRequest.holdRequestId);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("VENUE_HELD");

    const booking = await as("coordinatorThree", request(app).post(`/api/events/${raceEvent}/venue-bookings`).set("Idempotency-Key", nextKey())
      .send({ bookings: [{ venueId: venues.hall.venueId, label: `${prefix} booking`, start: AT("10:30"), end: AT("11:30"), expectedAttendance: 50, layout: "Theatre" }] }));
    if (booking.status < 300) recordFixtureIds(runId, "bookingIds", booking.body.bookings.map((row) => row.bookingId));
    expect(booking.status).toBe(409);
    expect(booking.body.code).toBe("BOOKING_CONFLICT");

    await as("coordinatorThree", request(app).post(`/api/venues/hold-requests/${rival.body.holdRequest.holdRequestId}/withdraw`));
  });

  test("[SPM-190-TC-05] a hold is extended once, within 1–7 days, then released by the coordinator", async () => {
    const [row] = (await holdRows(eventId)).filter((hold) => hold.status === "PLACED");
    const holdId = row.calendar_hold_id;
    const before = new Date((await calendarEntry(holdId)).holdExpiresAt).getTime();

    const tooLong = await as("venueStaff", request(app).post(`/api/venues/holds/${holdId}/extend`).send({ days: 8 }));
    expect(tooLong.status).toBe(400);
    const byCoordinator = await as("coordinator", request(app).post(`/api/venues/holds/${holdId}/extend`).send({ days: 2 }));
    expect(byCoordinator.status).toBe(403);

    const extended = await as("venueStaff", request(app).post(`/api/venues/holds/${holdId}/extend`).send({ days: 3 }));
    expect(extended.status).toBe(200);
    expect(extended.body.holdRequest.hold.extended).toBe(true);
    expect(new Date((await calendarEntry(holdId)).holdExpiresAt).getTime() - before).toBe(3 * DAY_MS);
    expect(await noticeTitles(eventId)).toContain("Venue hold extended");

    const twice = await as("venueStaff", request(app).post(`/api/venues/holds/${holdId}/extend`).send({ days: 1 }));
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("HOLD_ALREADY_EXTENDED");

    const released = await as("coordinator", request(app).post(`/api/venues/holds/${holdId}/release`));
    expect(released.status).toBe(200);
    expect(released.body.holdRequest.hold.status).toBe("RELEASED");
    expect((await calendarEntry(holdId)).status).toBe("RELEASED");

    const again = await as("venueStaff", request(app).post(`/api/venues/holds/${holdId}/release`));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("HOLD_NOT_ACTIVE");
  });

  test("[SPM-190-TC-06] a venue without setup and turnaround minutes cannot be held", async () => {
    const requested = await requestHold(eventId, venues.noBuffers, AT("10:00"), AT("11:00"));
    expect(requested.status).toBe(201);
    const placed = await placeHold(requested.body.holdRequest.holdRequestId);
    expect(placed.status).toBe(409);
    expect(placed.body.code).toBe("VENUE_BUFFERS_NOT_SET");
    await as("coordinator", request(app).post(`/api/venues/hold-requests/${requested.body.holdRequest.holdRequestId}/withdraw`));
  });

  test("[SPM-190-TC-07] the expiry job reminds once within 24 hours and expires an overdue hold once", async () => {
    const requested = await requestHold(eventId, venues.race, AT("10:00"), AT("11:00"));
    const placed = await placeHold(requested.body.holdRequest.holdRequestId);
    expect(placed.status).toBe(200);
    const { holdId } = placed.body.holdRequest.hold;
    const expiresAt = new Date((await calendarEntry(holdId)).holdExpiresAt).getTime();

    // One notice to the coordinator and one to Venue Staff; a repeat run adds none.
    const count = async (title) => (await noticeTitles(eventId)).filter((each) => each === title).length;
    const soon = new Date(expiresAt - 60 * 60 * 1000);
    expect(await venueModel.processDueHolds({ now: soon })).toMatchObject({ reminded: 1, expired: 0 });
    const reminders = await count("Venue hold expiring");
    expect(reminders).toBe(2);
    await venueModel.processDueHolds({ now: soon });
    expect(await count("Venue hold expiring")).toBe(reminders);

    const after = new Date(expiresAt + 60 * 1000);
    expect(await venueModel.processDueHolds({ now: after })).toMatchObject({ expired: 1 });
    expect((await calendarEntry(holdId)).status).toBe("EXPIRED");
    expect(await venueModel.processDueHolds({ now: after })).toMatchObject({ checked: 0, expired: 0 });
    expect(await count("Venue hold expired")).toBe(2);
  });

  test("[SPM-190-TC-08] two simultaneous placements for the same venue and time leave one hold", async () => {
    const [mine, theirs] = await Promise.all([
      requestHold(eventId, venues.annex, AT("10:00"), AT("11:00")),
      requestHold(raceEvent, venues.annex, AT("10:00"), AT("11:00")),
    ]);
    expect([mine.status, theirs.status]).toEqual([201, 201]);
    const results = await Promise.all([
      placeHold(mine.body.holdRequest.holdRequestId),
      placeHold(theirs.body.holdRequest.holdRequestId),
    ]);
    const outcomes = results.map((result) => `${result.status} ${result.body.code ?? ""}`.trim());
    expect(outcomes.filter((outcome) => outcome === "200")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome !== "200").every((outcome) => /^409 (VENUE_HELD|VENUE_LOCK_TIMEOUT)$/.test(outcome))).toBe(true);
    const db = await getMongoDb();
    expect(await db.collection("venue_calendar").countDocuments({ venueId: String(venues.annex.venueId), type: "HOLD", status: "ACTIVE" })).toBe(1);
  });

  test("[SPM-190-TC-09] the hold functions are not callable by anon, and only the lock role may place or change holds", async () => {
    const rows = await withPrivilegedDb(async (client) => (await client.query(`
      SELECT p.proname,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
             has_function_privilege('venue_calendar_writer', p.oid, 'EXECUTE') AS writer
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`, [[
      "request_venue_hold", "withdraw_venue_hold_request", "decline_venue_hold_request", "notify_venue_hold_expiry",
      "begin_venue_hold_placement", "record_venue_hold_placement", "begin_venue_hold_change", "record_venue_hold_change",
      "_lock_venue_hold_request", "_venue_staff_recipients", "_venue_hold_booking_conflicts",
    ]])).rows);
    const byName = Object.fromEntries(rows.map((row) => [row.proname, row]));
    expect(rows.every((row) => !row.anon)).toBe(true);
    for (const name of ["request_venue_hold", "withdraw_venue_hold_request", "decline_venue_hold_request", "notify_venue_hold_expiry"]) {
      expect(byName[name].service).toBe(true);
    }
    for (const name of ["begin_venue_hold_placement", "record_venue_hold_placement", "begin_venue_hold_change", "record_venue_hold_change"]) {
      expect(byName[name]).toMatchObject({ service: false, writer: true });
    }
    for (const name of ["_lock_venue_hold_request", "_venue_staff_recipients", "_venue_hold_booking_conflicts"]) {
      expect(byName[name]).toMatchObject({ service: false, writer: false });
    }
  });
});
