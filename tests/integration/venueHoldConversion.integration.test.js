// SPM-188 AC9/AC10 live integration tests: the coordinator confirms an active
// hold as a booking request through the real Express routes, Supabase Auth, the
// shared development database and the venue lock connection (Master 7.4).
// MongoDB is a local in-memory replica set (Master M7). Fixtures are synthetic
// and namespaced by run ID.
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
const { createLifecycleEvent, cleanupLifecycleRows } = require("../fixtures/lifecycleFixtures");

jest.setTimeout(180000);

const describeLive = process.env.VENUE_LOCK_DATABASE_URL && process.env.TEST_DATABASE_URL ? describe : describe.skip;

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const runId = newRunId();
const prefix = `spm188-${runId}`;
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

// The fixture event belongs to "coordinator"; the other event to "coordinatorThree".
const ownerOf = (targetEventId) => (targetEventId === eventId ? "coordinator" : "coordinatorThree");

// Requested by the coordinator, placed by Venue Staff; returns the hold ID.
const placedHold = async (targetEventId, venue, start, end) => {
  const requested = await as(ownerOf(targetEventId), request(app).post(`/api/events/${targetEventId}/venue-holds`).set("Idempotency-Key", nextKey())
    .send({ venueId: venue.venueId, label: `${prefix} hold`, start, end, expectedAttendance: 50, note: null }));
  if (requested.status !== 201) throw new Error(`Hold request failed: ${requested.status} ${requested.body.code}`);
  const placed = await as("venueStaff", request(app).post(`/api/venues/hold-requests/${requested.body.holdRequest.holdRequestId}/place`).set("Idempotency-Key", nextKey()));
  if (placed.status !== 200) throw new Error(`Hold placement failed: ${placed.status} ${placed.body.code}`);
  return placed.body.holdRequest.hold.holdId;
};

const bookingItem = (venue, start, end, holdId) => ({
  venueId: venue.venueId, label: `${prefix} booking`, start, end, expectedAttendance: 50, layout: "Theatre",
  ...(holdId ? { holdId } : {}),
});
const confirm = async (targetEventId, item, key = nextKey()) => {
  const response = await as(ownerOf(targetEventId), request(app).post(`/api/events/${targetEventId}/venue-bookings`).set("Idempotency-Key", key).send({ bookings: [item] }));
  if (response.status < 300) recordFixtureIds(runId, "bookingIds", response.body.bookings.map((booking) => booking.bookingId));
  return response;
};

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
const setExpiry = async (holdId, holdExpiresAt) =>
  (await getMongoDb()).collection("venue_calendar").updateOne({ _id: new ObjectId(holdId) }, { $set: { holdExpiresAt } });
const bookingsAt = async (targetEventId, venue) => {
  const { data, error } = await supabase.from("venue_booking")
    .select("booking_id,status,calendar_hold_id,start_datetime,end_datetime").eq("event_id", targetEventId).eq("venue_id", venue.venueId);
  if (error) throw error;
  return data;
};

describeLive("SPM-188 confirming a hold as a booking (live)", () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    process.env.MONGODB_URI = mongoServer.getUri();
    process.env.MONGODB_DB_NAME = `spm188_${runId}`;

    fixtures = await createAuthFixtures(runId);
    eventId = fixtures.events.reassignable;
    otherEvent = (await createLifecycleEvent(fixtures, {
      coordinator_id: fixtures.accounts.coordinatorThree.userId, start_datetime: AT("10:00"), end_datetime: AT("12:00"),
    })).event_id;

    for (const label of ["Hall", "Annex", "Studio", "Lab", "Race", "Repair"]) venues[label.toLowerCase()] = await insertVenue(label, 200);

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
        const manifestEvents = [...Object.values(fixtures.events), otherEvent].filter(Number.isInteger);
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

  test("[SPM-188-TC-13][AC9] confirming an active hold creates one pending booking and converts the hold", async () => {
    const holdId = await placedHold(eventId, venues.hall, AT("10:00"), AT("11:00"));

    // The coordinator's dry run does not count the event's own hold against it.
    const check = await as("coordinator", request(app).post(`/api/events/${eventId}/venue-bookings/check`)
      .send({ bookings: [bookingItem(venues.hall, AT("10:00"), AT("11:00"), holdId)] }));
    expect(check.status).toBe(200);
    expect(check.body.bookings[0].blocking).toEqual([]);

    const key = nextKey();
    const confirmed = await confirm(eventId, bookingItem(venues.hall, AT("10:00"), AT("11:00"), holdId), key);
    expect(confirmed.status).toBe(201);
    const [{ bookingId }] = confirmed.body.bookings;
    expect(await bookingsAt(eventId, venues.hall)).toEqual([expect.objectContaining({ booking_id: bookingId, status: "PENDING", calendar_hold_id: holdId })]);
    expect(await calendarEntry(holdId)).toMatchObject({ status: "CONVERTED", convertedBookingId: bookingId });

    const holds = await as("coordinator", request(app).get(`/api/events/${eventId}/venue-holds`));
    const hold = holds.body.holds.find((item) => item.hold?.holdId === holdId).hold;
    expect(hold).toMatchObject({ status: "CONVERTED", statusLabel: "Converted to a booking request", convertedBookingId: bookingId });

    // Venue Staff see it among the booking requests to decide.
    const { data: notices } = await supabase.from("notification").select("title").eq("event_id", eventId);
    expect(notices.map((row) => row.title)).toContain("New venue booking request");

    // A retry with the same key replays; a second confirmation is refused.
    const replay = await confirm(eventId, bookingItem(venues.hall, AT("10:00"), AT("11:00"), holdId), key);
    expect(replay.status).toBe(200);
    const again = await confirm(eventId, bookingItem(venues.hall, AT("10:00"), AT("11:00"), holdId));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("HOLD_ALREADY_CONVERTED");
    expect(await bookingsAt(eventId, venues.hall)).toHaveLength(1);
  });

  test("[SPM-188-AC9] a confirmation keeps the hold's times", async () => {
    const holdId = await placedHold(eventId, venues.annex, AT("10:00"), AT("11:00"));
    const response = await confirm(eventId, bookingItem(venues.annex, AT("10:00"), AT("11:30"), holdId));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("HOLD_WINDOW_CHANGED");
    expect(await bookingsAt(eventId, venues.annex)).toEqual([]);
    expect((await calendarEntry(holdId)).status).toBe("ACTIVE");
  });

  test("[SPM-188-AC9] another event's hold cannot be confirmed", async () => {
    const holdId = await placedHold(eventId, venues.studio, AT("10:00"), AT("11:00"));
    const response = await confirm(otherEvent, bookingItem(venues.studio, AT("10:00"), AT("11:00"), holdId));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("HOLD_NOT_FOUND");
    expect(await bookingsAt(otherEvent, venues.studio)).toEqual([]);
    expect((await calendarEntry(holdId)).status).toBe("ACTIVE");
  });

  test("[SPM-188-TC-14][AC9] an expired hold cannot be confirmed and nothing is saved", async () => {
    const holdId = await placedHold(eventId, venues.lab, AT("10:00"), AT("11:00"));
    await setExpiry(holdId, new Date(Date.now() - 60 * 1000));
    const response = await confirm(eventId, bookingItem(venues.lab, AT("10:00"), AT("11:00"), holdId));
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("HOLD_EXPIRED");
    expect(await bookingsAt(eventId, venues.lab)).toEqual([]);
    expect((await calendarEntry(holdId)).status).not.toBe("CONVERTED");
  });

  test("[T35] a hold whose COMMIT was lost is shown as not saved, and confirming again completes it", async () => {
    const holdId = await placedHold(eventId, venues.repair, AT("10:00"), AT("11:00"));
    // The state a lost COMMIT leaves: MongoDB converted, PostgreSQL never saved booking 999999.
    await (await getMongoDb()).collection("venue_calendar").updateOne(
      { _id: new ObjectId(holdId) }, { $set: { status: "CONVERTED", convertedBookingId: 999999 }, $inc: { version: 1 } },
    );
    const holdView = async () => (await as("coordinator", request(app).get(`/api/events/${eventId}/venue-holds`)))
      .body.holds.find((item) => item.hold?.holdId === holdId).hold;
    expect(await holdView()).toMatchObject({ status: "CONVERTED", statusLabel: "Booking not saved – confirm again", bookingMissing: true, convertedBooking: null });

    const confirmed = await confirm(eventId, bookingItem(venues.repair, AT("10:00"), AT("11:00"), holdId));
    expect(confirmed.status).toBe(201);
    const [{ bookingId }] = confirmed.body.bookings;
    expect(await calendarEntry(holdId)).toMatchObject({ status: "CONVERTED", convertedBookingId: bookingId });
    expect(await holdView()).toMatchObject({
      status: "CONVERTED", statusLabel: "Converted to a booking request", bookingMissing: false,
      convertedBooking: { bookingId, status: "PENDING", statusLabel: "Pending" },
    });

    // Venue Staff see it on My Requests, marked as coming from a hold.
    const listed = await as("venueStaff", request(app).get(`/api/venues/bookings?eventId=${eventId}&status=PENDING`));
    expect(listed.status).toBe(200);
    expect(listed.body.bookings.find((booking) => booking.bookingId === bookingId)).toMatchObject({ fromHold: true });

    // Once approved, the coordinator is told and the hold shows the decision.
    const approved = await as("venueStaff", request(app).post(`/api/venues/bookings/${bookingId}/approve`).send({ expectedStatus: "PENDING" }));
    expect(approved.status).toBe(200);
    const { data: notices } = await supabase.from("notification").select("title").eq("event_id", eventId);
    expect(notices.map((row) => row.title)).toContain("Venue booking approved");
    expect((await holdView()).convertedBooking).toMatchObject({ status: "APPROVED", statusLabel: "Approved" });
  });

  test("[SPM-188-TC-15][AC10] a confirmation at the moment of expiry either converts or expires the hold, never both", async () => {
    const holdId = await placedHold(otherEvent, venues.race, AT("10:00"), AT("11:00"));
    const expiresAt = Date.now() + 1500;
    await setExpiry(holdId, new Date(expiresAt));
    await new Promise((resolve) => { setTimeout(resolve, Math.max(0, expiresAt - Date.now() - 20)); });

    const [confirmed, job] = await Promise.all([
      confirm(otherEvent, bookingItem(venues.race, AT("10:00"), AT("11:00"), holdId)),
      venueModel.processDueHolds(),
    ]);
    // Whatever the job did not reach in its run, a later run settles.
    await new Promise((resolve) => { setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 50)); });
    await venueModel.processDueHolds();

    const entry = await calendarEntry(holdId);
    const saved = await bookingsAt(otherEvent, venues.race);
    if (confirmed.status === 201) {
      expect(entry.status).toBe("CONVERTED");
      expect(saved).toEqual([expect.objectContaining({ calendar_hold_id: holdId, status: "PENDING" })]);
    } else {
      expect(confirmed.status).toBe(409);
      expect(["HOLD_EXPIRED", "HOLD_NOT_ACTIVE", "VENUE_LOCK_TIMEOUT"]).toContain(confirmed.body.code);
      expect(entry.status).toBe("EXPIRED");
      expect(saved).toEqual([]);
    }
    expect(job).toEqual(expect.objectContaining({ checked: expect.any(Number) }));
  });
});
