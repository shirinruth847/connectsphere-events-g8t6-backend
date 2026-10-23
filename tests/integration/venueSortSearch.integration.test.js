// SPM-181 follow-up, live: real Express routes, Supabase Auth and the shared
// development database; MongoDB is a local in-memory replica set (Master 11,
// M7), never Atlas. Needs migration 20261021090000_spm181_booking_id_and_updated_at.
// Fixtures are namespaced spm32-<run>, recorded in the manifest and removed
// afterwards; the extra booking and venue made here are added to the manifest.
const { MongoMemoryReplSet } = require("mongodb-memory-server");

jest.setTimeout(180000);

const ORIGINAL_ENV = { ...process.env };
let replSet;
let request;
let app;
let supabase;
let fixtures;
let fixtureHelpers;
let mongo;
let signInWithPassword;

const sessions = new Map();
const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed: ${error ? error.message : "no session"}`);
      return session;
    }));
  }
  return sessions.get(key);
};
const get = async (key, path) => request(app).get(path).set("Authorization", `Bearer ${(await signIn(key)).access_token}`);

let runId;
let pendingBookingId;
let secondVenueId;

beforeAll(async () => {
  // The in-memory store must be configured before the app loads its MongoDB client.
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = "spm181_integration";

  request = require("supertest");
  app = require("../../server");
  supabase = require("../../config/supabase");
  fixtureHelpers = require("../fixtures/authFixtures");
  ({ signInWithPassword } = require("../fixtures/browserAuthClient"));
  mongo = require("../../config/mongodb");
  const { applyMigrations } = require("../../mongodb/migrate");
  await applyMigrations(await mongo.getMongoDb());

  runId = fixtureHelpers.newRunId();
  fixtures = await fixtureHelpers.createAuthFixtures(runId);

  // A pending booking with attendance and a label, on the planning fixture event.
  const { data: booking, error } = await supabase
    .from("venue_booking")
    .insert({
      room_id: fixtures.venue.roomId,
      event_id: fixtures.events.registeredPlanning,
      requested_by: fixtures.accounts.coordinator.userId,
      start_datetime: "2027-03-04T01:00:00Z",
      end_datetime: "2027-03-04T03:00:00Z",
      status: "PENDING",
      label: `spm32-${runId} breakout`,
      expected_attendance: 80,
    })
    .select("booking_id")
    .single();
  if (error) throw error;
  pendingBookingId = booking.booking_id;
  fixtureHelpers.recordFixtureIds(runId, "bookingIds", [pendingBookingId]);

  // A second venue so My Venues sorting has something to order.
  const { data: venue, error: venueError } = await supabase
    .from("venue")
    .insert({ name: `spm32-${runId} Annex`, address: `spm32-${runId} 2 Test Road`, max_capacity: 50 })
    .select("venue_id")
    .single();
  if (venueError) throw venueError;
  secondVenueId = venue.venue_id;
  fixtureHelpers.recordFixtureIds(runId, "venueIds", [secondVenueId]);

  const db = await mongo.getMongoDb();
  await db.collection("venue_details").insertMany([
    { _id: String(fixtures.venue.venueId), pg_version: 1, name: "Hall", location: "Road", setupMinutes: 45, turnaroundMinutes: 10, version: 1 },
    { _id: String(secondVenueId), pg_version: 1, name: "Annex", location: "Road", setupMinutes: 15, turnaroundMinutes: 30, version: 1 },
  ]);
});

afterAll(async () => {
  // MongoDB documents go before the PostgreSQL rows (Master 10.4).
  if (mongo) {
    await (await mongo.getMongoDb()).collection("venue_details").deleteMany({ _id: { $in: [String(fixtures?.venue?.venueId), String(secondVenueId)] } });
    await mongo.closeMongoDb();
  }
  if (runId) await fixtureHelpers.cleanupAuthFixtures(runId);
  if (replSet) await replSet.stop();
  process.env = ORIGINAL_ENV;
});

const runBookings = async (query = "") => {
  const response = await get("venueStaff", `/api/venues/bookings?q=${encodeURIComponent(`spm32-${runId}`)}${query}`);
  expect(response.status).toBe(200);
  return response.body.bookings;
};

describe("GET /api/venues/bookings search and sort (live)", () => {
  test("[TC-VENUE-181-70] should_find_this_runs_bookings_by_event_title_and_put_pending_first_by_default", async () => {
    const bookings = await runBookings();

    expect(bookings).toHaveLength(4);
    expect(bookings[0]).toMatchObject({ bookingId: pendingBookingId, status: "PENDING" });
    expect(bookings.slice(1).map((booking) => booking.status)).toEqual(["APPROVED", "APPROVED", "REJECTED"]);
    for (const booking of bookings) {
      expect(booking).toEqual(expect.objectContaining({ bookingId: expect.any(Number), updatedAt: expect.any(String) }));
      expect(booking).not.toHaveProperty("bookingReference");
    }
  });

  test("[TC-VENUE-181-71] should_find_a_booking_by_its_id_with_or_without_a_hash", async () => {
    for (const q of [String(pendingBookingId), `#${pendingBookingId}`]) {
      const response = await get("venueStaff", `/api/venues/bookings?q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(200);
      expect(response.body.bookings.map((booking) => booking.bookingId)).toContain(pendingBookingId);
    }
  });

  test("[TC-VENUE-181-72] should_find_bookings_by_request_reference_and_label", async () => {
    const eventId = fixtures.events.registeredPlanning;
    const byRequest = await get("venueStaff", `/api/venues/bookings?q=REQ-${String(eventId).padStart(6, "0")}`);
    expect(byRequest.body.bookings.every((booking) => booking.event.eventId === eventId)).toBe(true);
    expect(byRequest.body.bookings.length).toBeGreaterThanOrEqual(2);

    const byLabel = await get("venueStaff", `/api/venues/bookings?q=${encodeURIComponent(`spm32-${runId} breakout`)}`);
    expect(byLabel.body.bookings.map((booking) => booking.bookingId)).toEqual([pendingBookingId]);
  });

  test("[TC-VENUE-181-73] should_sort_by_attendance_with_unrecorded_attendance_last", async () => {
    const descending = await runBookings("&sort=attendance&order=desc");
    expect(descending[0].bookingId).toBe(pendingBookingId);
    const ascending = await runBookings("&sort=attendance&order=asc");
    expect(ascending[0].bookingId).toBe(pendingBookingId);
    expect(ascending.slice(1).every((booking) => booking.expectedAttendance === null)).toBe(true);
  });

  test("[TC-VENUE-181-74] should_sort_by_date_in_both_directions", async () => {
    const ascending = await runBookings("&sort=date&order=asc");
    const starts = ascending.map((booking) => Date.parse(booking.startDatetime));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const descending = await runBookings("&sort=date&order=desc");
    expect(descending.map((booking) => booking.bookingId)).toEqual(ascending.map((booking) => booking.bookingId).reverse());
  });

  test("[TC-VENUE-181-75] should_sort_alphabetically_by_event_title", async () => {
    const ascending = await runBookings("&sort=alphabetical&order=asc");
    const titles = ascending.map((booking) => booking.event.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    expect(titles[0]).toMatch(/registeredConfirmed$/);
  });

  test("[TC-VENUE-181-76] should_move_an_edited_booking_to_the_top_of_last_edited_as_the_trigger_sets_updated_at", async () => {
    const before = await runBookings("&sort=lastEdited&order=desc");
    const target = before.at(-1);

    const { error } = await supabase.from("venue_booking").update({ special_requirements: "Edited by the SPM-181 integration test" }).eq("booking_id", target.bookingId);
    expect(error).toBeNull();

    const after = await runBookings("&sort=lastEdited&order=desc");
    expect(after[0].bookingId).toBe(target.bookingId);
    expect(Date.parse(after[0].updatedAt)).toBeGreaterThan(Date.parse(target.updatedAt));
  });

  test("[TC-VENUE-181-77] should_refuse_an_unknown_sort_and_other_roles", async () => {
    expect((await get("venueStaff", "/api/venues/bookings?sort=lastOpened")).status).toBe(400);
    expect((await get("coordinator", "/api/venues/bookings?q=x")).status).toBe(403);
    expect((await request(app).get("/api/venues/bookings?q=x")).status).toBe(401);
  });
});

describe("GET /api/venues/manage sort and /manage/options (live)", () => {
  const runVenues = async (query) => {
    const response = await get("venueStaff", `/api/venues/manage?search=${encodeURIComponent(`spm32-${runId}`)}${query}`);
    expect(response.status).toBe(200);
    return response.body;
  };

  test("[TC-VENUE-181-78] should_sort_by_setup_and_turnaround_minutes_from_mongodb", async () => {
    const setupAsc = await runVenues("&sort=setupMinutes&order=asc");
    expect(setupAsc.venues.map((venue) => venue.venueId)).toEqual([secondVenueId, fixtures.venue.venueId]);
    expect(setupAsc.venues.map((venue) => venue.setupMinutes)).toEqual([15, 45]);
    expect(setupAsc).toMatchObject({ detailsAvailable: true, sortNotChecked: false });

    const turnaroundAsc = await runVenues("&sort=turnaroundMinutes&order=asc");
    expect(turnaroundAsc.venues.map((venue) => venue.venueId)).toEqual([fixtures.venue.venueId, secondVenueId]);
  });

  test("[TC-VENUE-181-79] should_sort_by_capacity_in_postgresql", async () => {
    const descending = await runVenues("&sort=capacity&order=desc");
    expect(descending.venues.map((venue) => venue.maxCapacity)).toEqual([200, 50]);
    const ascending = await runVenues("&sort=capacity&order=asc");
    expect(ascending.venues.map((venue) => venue.maxCapacity)).toEqual([50, 200]);
  });

  test("[TC-VENUE-181-80] should_list_new_venues_in_the_options_and_drop_deleted_ones", async () => {
    const before = await get("venueStaff", "/api/venues/manage/options");
    expect(before.status).toBe(200);
    expect(before.body.venues.map((venue) => venue.venueId)).toEqual(expect.arrayContaining([fixtures.venue.venueId, secondVenueId]));

    // Deleting a venue as unusable keeps the row with is_active = false (SPM-72).
    const { error } = await supabase.from("venue").update({ is_active: false }).eq("venue_id", secondVenueId);
    expect(error).toBeNull();
    const after = await get("venueStaff", "/api/venues/manage/options");
    expect(after.body.venues.map((venue) => venue.venueId)).not.toContain(secondVenueId);
  });

  test("[TC-VENUE-181-81] should_refuse_the_options_to_other_roles", async () => {
    expect((await get("coordinator", "/api/venues/manage/options")).status).toBe(403);
    expect((await get("organiserA", "/api/venues/manage/options")).status).toBe(403);
  });
});
