// SPM-73 live integration tests: real routes, Supabase Auth and the shared
// development database. Needs migration 20261020090836_spm73_venue_catalogue_maintenance.
// Venues are synthetic (spm73-<run> ...), recorded in the fixture manifest and
// removed afterwards. Their audit entries are append-only: without
// TEST_DATABASE_URL the Venue Staff fixture profile that wrote them is kept,
// deactivated, like every suite that writes history.
//
// TC-10 (cancel creation) is a browser-only step: a cancelled form sends no
// request, so there is nothing for the backend to check.
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { applyMigrations } = require("../../mongodb/migrate");
const { MAX_VENUE_CAPACITY } = require("../../config/venueConstants");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { createLifecycleEvent } = require("../fixtures/lifecycleFixtures");

jest.setTimeout(120000);

const runId = newRunId();
const prefix = `spm73-${runId}`;
let fixtures;
// The confirmed event that holds the upcoming 2030 booking (see addUpcomingBooking).
let upcomingEventId;
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      return session;
    }));
  }
  return sessions.get(key);
};

const call = async (key, method, path, body) => {
  const session = await signIn(key);
  const builder = request(app)[method](path).set("Authorization", `Bearer ${session.access_token}`);
  return body === undefined ? builder : builder.send(body);
};

const venueBody = (label, overrides = {}) => ({
  name: `${prefix} ${label}`,
  address: `${prefix} 10 Bayfront Avenue`,
  maxCapacity: 500,
  contactPerson: "Alex Tan",
  contactEmail: "alex.tan@example.com",
  contactNumber: "+65 6123 4567",
  status: "ACTIVE",
  ...overrides,
});

// Creates through the API as Venue Staff and records the ID for cleanup.
const createVenue = async (label, overrides) => {
  const response = await call("venueStaff", "post", "/api/venues", venueBody(label, overrides));
  if (response.status === 201) recordFixtureIds(runId, "venueIds", [response.body.venue.venueId]);
  return response;
};

const countVenues = async (column, value) => {
  const { count, error } = await supabase.from("venue").select("venue_id", { count: "exact", head: true }).ilike(column, value);
  if (error) throw error;
  return count;
};

const auditFor = async (venueId) => {
  const { data, error } = await supabase
    .from("activity_log")
    .select("action,user_id,changes,audience")
    .eq("entity_name", "venue")
    .eq("entity_id", venueId)
    .order("log_id", { ascending: true });
  if (error) throw error;
  return data;
};

// A room and an upcoming PENDING booking on the venue, recorded for cleanup.
const addUpcomingBooking = async (venueId) => {
  const { data: room, error: roomError } = await supabase
    .from("room").insert({ venue_id: venueId, layout_type: "THEATRE", capacity: 100 }).select("room_id").single();
  if (roomError) throw roomError;
  recordFixtureIds(runId, "roomIds", [room.room_id]);
  // A booking lies within its event (Master 6.3, SPM-179 trigger), so the 2030
  // booking gets its own confirmed event spanning it.
  const host = await createLifecycleEvent(fixtures, {
    status: "CONFIRMED", start_datetime: "2030-01-01T01:00:00Z", end_datetime: "2030-01-01T03:00:00Z",
  });
  upcomingEventId = host.event_id;
  const { data: booking, error } = await supabase
    .from("venue_booking")
    .insert({
      room_id: room.room_id,
      event_id: upcomingEventId,
      requested_by: fixtures.accounts.coordinator.userId,
      start_datetime: "2030-01-01T01:00:00Z",
      end_datetime: "2030-01-01T03:00:00Z",
      status: "PENDING",
    })
    .select("booking_id")
    .single();
  if (error) throw error;
  recordFixtureIds(runId, "bookingIds", [booking.booking_id]);
  return booking.booking_id;
};

const catalogueIds = async () => (await call("coordinator", "get", "/api/venues")).body.venues.map(({ venueId }) => venueId);
const requestOptionIds = async () =>
  (await call("organiserA", "get", "/api/events/request-options")).body.venues.map(({ venueId }) => venueId);

// Master 11: venue details come from a local in-memory replica set, never Atlas.
// Closing the client in afterAll also lets Jest exit instead of waiting on it.
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
let replSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = `spm73_${runId}`;
  await applyMigrations(await getMongoDb());
  fixtures = await createAuthFixtures(runId);
});

afterAll(async () => {
  try {
    await cleanupAuthFixtures(runId);
  } finally {
    await closeMongoDb();
    if (replSet) await replSet.stop();
    process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
    process.env.MONGODB_DB_NAME = ORIGINAL_MONGODB_DB_NAME;
  }
});

describe("SPM-73 venue catalogue maintenance", () => {
  let marina;

  test("[SPM-73-TC1] should_create_an_active_bookable_venue_and_audit_it", async () => {
    const response = await createVenue("Marina Conference Hall");

    expect(response.status).toBe(201);
    expect(response.body.message).toBe("Venue created.");
    marina = response.body.venue;
    expect(marina).toEqual(expect.objectContaining({
      name: `${prefix} Marina Conference Hall`,
      maxCapacity: 500,
      contactPerson: "Alex Tan",
      contactEmail: "alex.tan@example.com",
      contactNumber: "+65 6123 4567",
      status: "ACTIVE",
      version: 1,
      createdBy: { userId: fixtures.accounts.venueStaff.userId, name: expect.any(String) },
    }));

    const listed = await call("venueStaff", "get", `/api/venues/manage?search=${encodeURIComponent(`${prefix} Marina`)}`);
    expect(listed.body.venues.map(({ venueId }) => venueId)).toEqual([marina.venueId]);
    expect(await catalogueIds()).toContain(marina.venueId);
    expect(await requestOptionIds()).toContain(marina.venueId);

    const audit = await auditFor(marina.venueId);
    expect(audit).toEqual([expect.objectContaining({
      action: "VENUE_CREATED",
      user_id: fixtures.accounts.venueStaff.userId,
      audience: "STAFF_ONLY",
    })]);
  });

  test("[SPM-73-TC2] should_block_missing_name_and_capacity_and_create_nothing", async () => {
    const address = `${prefix} TC2 Road`;
    const response = await call("venueStaff", "post", "/api/venues", venueBody("ignored", { name: "", maxCapacity: "", address }));

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ name: "Venue name is required", maxCapacity: "Capacity is required" });
    expect(await countVenues("address", address)).toBe(0);
  });

  test.each([0, -10, 10.5, "text"])("[SPM-73-TC3] should_reject_capacity_%p_and_create_nothing", async (maxCapacity) => {
    const label = `TC3 ${String(maxCapacity)}`;
    const response = await call("venueStaff", "post", "/api/venues", venueBody(label, { maxCapacity }));

    expect(response.status).toBe(400);
    expect(response.body.fields.maxCapacity).toBe("Capacity must be a positive whole number");
    expect(await countVenues("name", `${prefix} ${label}`)).toBe(0);
  });

  test("[SPM-73-TC4] should_accept_capacity_1_and_the_maximum_and_reject_above_it", async () => {
    expect((await createVenue("TC4 minimum", { maxCapacity: 1 })).status).toBe(201);
    expect((await createVenue("TC4 maximum", { maxCapacity: MAX_VENUE_CAPACITY })).status).toBe(201);

    const above = await createVenue("TC4 above", { maxCapacity: MAX_VENUE_CAPACITY + 1 });
    expect(above.status).toBe(400);
    expect(await countVenues("name", `${prefix} TC4 above`)).toBe(0);
  });

  test("[SPM-73-TC5] should_block_a_duplicate_name_in_any_letter_case", async () => {
    const response = await createVenue("MARINA conference HALL");

    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({
      code: "VENUE_NAME_TAKEN",
      fields: { name: "A venue with this name already exists" },
    }));
    expect(await countVenues("name", `${prefix} marina conference hall`)).toBe(1);
  });

  test("[SPM-73-TC6] should_update_details_keep_bookings_linked_and_audit_the_change", async () => {
    const bookingId = await addUpcomingBooking(marina.venueId);

    const response = await call("venueStaff", "put", `/api/venues/${marina.venueId}`, {
      maxCapacity: 650,
      contactNumber: "+65 6000 0000",
      version: marina.version,
    });

    expect(response.status).toBe(200);
    expect(response.body.venue).toEqual(expect.objectContaining({ maxCapacity: 650, contactNumber: "+65 6000 0000", version: 2 }));
    expect(response.body.venue.updatedBy.userId).toBe(fixtures.accounts.venueStaff.userId);

    // Persists on reload.
    const reloaded = await call("venueStaff", "get", `/api/venues/${marina.venueId}`);
    expect(reloaded.body.venue).toEqual(expect.objectContaining({ maxCapacity: 650, version: 2 }));
    marina = reloaded.body.venue;

    const { data: booking } = await supabase.from("venue_booking").select("room_id,status,room(venue_id)").eq("booking_id", bookingId).single();
    expect(booking).toEqual(expect.objectContaining({ status: "PENDING", room: { venue_id: marina.venueId } }));

    const updated = (await auditFor(marina.venueId)).find(({ action }) => action === "VENUE_UPDATED");
    expect(updated.changes).toEqual({
      maxCapacity: { before: 500, after: 650 },
      contactNumber: { before: "+65 6123 4567", after: "+65 6000 0000" },
    });
  });

  test("[SPM-73-TC6] should_refuse_a_save_made_against_an_older_version", async () => {
    const response = await call("venueStaff", "put", `/api/venues/${marina.venueId}`, { maxCapacity: 700, version: 1 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("VENUE_VERSION_CONFLICT");
    expect((await call("venueStaff", "get", `/api/venues/${marina.venueId}`)).body.venue.maxCapacity).toBe(650);
  });

  test("[SPM-73-TC8] should_warn_about_upcoming_bookings_then_deactivate_once_confirmed", async () => {
    const warned = await call("venueStaff", "put", `/api/venues/${marina.venueId}/status`, { status: "INACTIVE", version: marina.version });

    expect(warned.status).toBe(409);
    expect(warned.body).toEqual(expect.objectContaining({ code: "VENUE_HAS_UPCOMING_BOOKINGS", upcomingBookings: 1 }));
    expect((await call("venueStaff", "get", `/api/venues/${marina.venueId}`)).body.venue.status).toBe("ACTIVE");

    const confirmed = await call("venueStaff", "put", `/api/venues/${marina.venueId}/status`, {
      status: "INACTIVE",
      version: marina.version,
      confirmUpcomingBookings: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toEqual(expect.objectContaining({ upcomingBookings: 1 }));
    expect(confirmed.body.venue.status).toBe("INACTIVE");
    marina = confirmed.body.venue;

    // Bookings are kept; the venue stays in the records but cannot be chosen.
    const { count } = await supabase.from("venue_booking").select("booking_id", { count: "exact", head: true })
      .eq("event_id", upcomingEventId).eq("status", "PENDING").gte("start_datetime", "2030-01-01T00:00:00Z");
    expect(count).toBe(1);
    expect(await catalogueIds()).not.toContain(marina.venueId);
    expect(await requestOptionIds()).not.toContain(marina.venueId);
    const inactive = await call("venueStaff", "get", `/api/venues/manage?status=INACTIVE&search=${encodeURIComponent(prefix)}`);
    expect(inactive.body.venues.map(({ venueId }) => venueId)).toContain(marina.venueId);
  });

  test("[SPM-73-TC7] should_put_a_venue_under_maintenance_with_its_reason_and_hide_it_from_selection", async () => {
    const created = await createVenue("TC7 Riverside Hall");
    const venue = created.body.venue;

    const noReason = await call("venueStaff", "put", `/api/venues/${venue.venueId}/status`, { status: "UNDER_MAINTENANCE", version: 1 });
    expect(noReason.status).toBe(400);

    const response = await call("venueStaff", "put", `/api/venues/${venue.venueId}/status`, {
      status: "UNDER_MAINTENANCE",
      reason: "Roof repair",
      version: 1,
    });
    expect(response.status).toBe(200);
    expect(response.body.venue).toEqual(expect.objectContaining({ status: "UNDER_MAINTENANCE", statusReason: "Roof repair", version: 2 }));
    expect(await catalogueIds()).not.toContain(venue.venueId);
    expect(await requestOptionIds()).not.toContain(venue.venueId);

    const statusChange = (await auditFor(venue.venueId)).find(({ action }) => action === "VENUE_STATUS_CHANGED");
    expect(statusChange.changes).toEqual({
      status: { before: "ACTIVE", after: "UNDER_MAINTENANCE" },
      statusReason: { before: null, after: "Roof repair" },
    });
  });

  test.each(["coordinator", "coordinatorLead", "organiserA", "techSupport", "attendee"])(
    "[SPM-73-TC9] should_deny_%s_venue_management_and_change_nothing",
    async (key) => {
      const label = `TC9 ${key}`;
      expect((await call(key, "post", "/api/venues", venueBody(label))).status).toBe(403);
      expect((await call(key, "put", `/api/venues/${marina.venueId}`, { maxCapacity: 1, version: marina.version })).status).toBe(403);
      expect((await call(key, "put", `/api/venues/${marina.venueId}/status`, { status: "ACTIVE", version: marina.version })).status).toBe(403);
      expect((await call(key, "get", "/api/venues/manage")).status).toBe(403);

      expect(await countVenues("name", `${prefix} ${label}`)).toBe(0);
      const { data } = await supabase.from("venue").select("max_capacity,status,version").eq("venue_id", marina.venueId).single();
      expect(data).toEqual({ max_capacity: 650, status: "INACTIVE", version: marina.version });
    }
  );

  test("[SPM-73-TC11] should_search_and_filter_by_name_location_and_status", async () => {
    const base = `/api/venues/manage?limit=100&search=${encodeURIComponent(prefix.toUpperCase())}`;
    const all = (await call("venueStaff", "get", base)).body.venues;
    const names = all.map(({ name }) => name);
    expect(names).toEqual(expect.arrayContaining([
      `${prefix} Marina Conference Hall`,
      `${prefix} TC4 minimum`,
      `${prefix} TC7 Riverside Hall`,
    ]));

    const active = (await call("venueStaff", "get", `${base}&status=ACTIVE`)).body.venues;
    expect(active.every(({ status }) => status === "ACTIVE")).toBe(true);
    expect(active.map(({ venueId }) => venueId)).not.toContain(marina.venueId);

    const inactive = (await call("venueStaff", "get", `${base}&status=INACTIVE`)).body.venues;
    expect(inactive.map(({ venueId }) => venueId)).toEqual([marina.venueId]);

    const byLocation = (await call("venueStaff", "get", `${base}&location=${encodeURIComponent("bayfront avenue")}`)).body.venues;
    expect(byLocation).toHaveLength(all.length);
    const nowhere = (await call("venueStaff", "get", `${base}&location=${encodeURIComponent("Nowhere Street")}`)).body.venues;
    expect(nowhere).toEqual([]);
  });
});
