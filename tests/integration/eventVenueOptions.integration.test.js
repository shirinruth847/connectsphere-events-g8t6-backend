// SPM-72/SPM-74 live integration tests: the venue section of an event, with
// real Express routes, Supabase Auth and the shared development database.
// MongoDB is a local in-memory server (Master M7). Fixtures are synthetic,
// namespaced by run ID and removed afterwards.
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { applyMigrations } = require("../../mongodb/migrate");
const venuePhotoModel = require("../../model/venuePhotoModel");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const runId = newRunId();
const prefix = `spm72v-${runId}`;
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let fixtures;
let mongoServer;
let eventId;
const venues = {};
const sessions = new Map();

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
const getOptions = async (key, query = "") =>
  as(key, request(app).get(`/api/events/${eventId}/venue-options?search=${encodeURIComponent(prefix)}${query}`));
const suggest = async (key, body, idempotencyKey) =>
  as(key, request(app).put(`/api/events/${eventId}/venue-suggestion`).set("Idempotency-Key", idempotencyKey).send(body));

const insertVenue = async (label, row) => {
  const { data, error } = await supabase.from("venue")
    .insert({ name: `${prefix} ${label}`, address: `${prefix} ${label} Road`, operating_hours: "08:00-22:00", ...row })
    .select("venue_id").single();
  if (error) throw new Error(`Fixture venue ${label} failed: ${error.message}`);
  recordFixtureIds(runId, "venueIds", [data.venue_id]);
  const { data: room, error: roomError } = await supabase.from("room")
    .insert({ venue_id: data.venue_id, layout_type: "THEATRE", capacity: row.max_capacity })
    .select("room_id").single();
  if (roomError) throw new Error(`Fixture room ${label} failed: ${roomError.message}`);
  recordFixtureIds(runId, "roomIds", [room.room_id]);
  return { venueId: data.venue_id, roomId: room.room_id };
};

const insertBooking = async (roomId, bookingEventId, start, end) => {
  const { data, error } = await supabase.from("venue_booking").insert({
    room_id: roomId,
    event_id: bookingEventId,
    requested_by: fixtures.accounts.coordinator.userId,
    start_datetime: start,
    end_datetime: end,
    status: "APPROVED",
  }).select("booking_id").single();
  if (error) throw new Error(`Fixture booking failed: ${error.message}`);
  recordFixtureIds(runId, "bookingIds", [data.booking_id]);
};

const details = (venueId, extra = {}) => ({
  _id: String(venueId),
  pg_version: 1,
  name: `${prefix} venue`,
  location: `${prefix} road`,
  facilities: ["Projector", "PA system"],
  accessibilityFeatures: ["Internal accessibility note desk"],
  supportedLayouts: ["THEATRE"],
  setupMinutes: 30,
  turnaroundMinutes: 45,
  version: 1,
  ...extra,
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.MONGODB_DB_NAME = `spm72v_${runId}`;

  fixtures = await createAuthFixtures(runId);
  // PLANNING, assigned to "coordinator" by "coordinatorLead", 2027-03-10 10:00-12:00 UTC, 50 expected.
  eventId = fixtures.events.reassignable;

  venues.fits = await insertVenue("Fits", { max_capacity: 300 });
  venues.small = await insertVenue("Small", { max_capacity: 20 });
  venues.booked = await insertVenue("Booked", { max_capacity: 400 });
  venues.noBuffers = await insertVenue("NoBuffers", { max_capacity: 500 });
  venues.inactive = await insertVenue("Inactive", { max_capacity: 300, status: "INACTIVE" });

  const db = await getMongoDb();
  await applyMigrations(db);
  await db.collection("venue_details").insertMany([
    details(venues.fits.venueId),
    details(venues.small.venueId),
    details(venues.booked.venueId, { facilities: [] }),
    details(venues.noBuffers.venueId, { setupMinutes: undefined, turnaroundMinutes: undefined }),
  ].map((document) => JSON.parse(JSON.stringify(document))));

  // Another event's booking ends 09:30 + 45 min turnaround = 10:15, inside the event's setup (09:30).
  await insertBooking(venues.booked.roomId, fixtures.events.coordinatorTwoBusy, "2027-03-10T08:00:00Z", "2027-03-10T09:30:00Z");
  // The event's own booking never conflicts with itself.
  await insertBooking(venues.fits.roomId, eventId, "2027-03-10T10:00:00Z", "2027-03-10T12:00:00Z");

  await venuePhotoModel.addPhoto({ venueId: venues.fits.venueId, contentType: "image/png", data: PNG, size: PNG.length, caption: "Front", actorId: fixtures.accounts.venueStaff.userId });
  await venuePhotoModel.addPhoto({ venueId: venues.inactive.venueId, contentType: "image/png", data: PNG, size: PNG.length, caption: "Hidden", actorId: fixtures.accounts.venueStaff.userId });
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

const byName = (body, label) => body.venues.find((venue) => venue.name === `${prefix} ${label}`);
const statusOf = (venue, key) => venue.requirements.find((item) => item.key === key)?.status;

describe("GET /api/events/:id/venue-options (SPM-72/74)", () => {
  test("[TC-VC-001][TC-VC-003][SPM-72-AC4] should_list_available_venues_without_inactive_ones", async () => {
    const response = await getOptions("coordinator");

    expect(response.status).toBe(200);
    expect(response.body.canSuggestVenue).toBe(true);
    expect(response.body.availabilityChecked).toBe(true);
    const names = response.body.venues.map((venue) => venue.name);
    expect(names).toEqual(expect.arrayContaining([`${prefix} Fits`, `${prefix} Small`, `${prefix} Booked`, `${prefix} NoBuffers`]));
    expect(names).not.toContain(`${prefix} Inactive`);
  });

  test("[SPM-74-TC03][TC-VC-006][SPM-72-AC6] should_show_availability_for_the_event_date_with_setup_and_turnaround", async () => {
    const { body } = await getOptions("coordinator");

    const fits = byName(body, "Fits");
    expect(fits.availability.status).toBe("AVAILABLE");
    expect(fits.availability.occupiedStart).toBe("2027-03-10T09:30:00.000Z");
    expect(fits.availability.occupiedEnd).toBe("2027-03-10T12:45:00.000Z");

    const booked = byName(body, "Booked");
    expect(booked.availability.status).toBe("UNAVAILABLE_BOOKING");
    expect(booked.availability.conflicts).toEqual([expect.objectContaining({ type: "BOOKING", occupiedEnd: "2027-03-10T10:15:00.000Z" })]);
    expect(statusOf(booked, "availability")).toBe("UNMET");

    expect(byName(body, "NoBuffers").availability.status).toBe("NOT_BOOKABLE");
  });

  test("[TC-VC-005][SPM-72-AC5] should_rank_venues_meeting_more_requirements_first", async () => {
    const { body } = await getOptions("coordinator", "&requiredFacilities=Projector&sort=capacity&order=desc");

    const ours = body.venues.filter((venue) => venue.name.startsWith(prefix));
    expect(ours[0].name).toBe(`${prefix} Fits`);
    expect(statusOf(ours[0], "capacity")).toBe("MET");
    expect(statusOf(ours[0], "facility-0")).toBe("MET");
    expect(statusOf(byName(body, "Small"), "capacity")).toBe("UNMET");
    const unmet = ours.map((venue) => venue.unmetCount);
    expect([...unmet].sort((a, b) => a - b)).toEqual(unmet);
  });

  test("[TC-VC-004][SPM-72-AC3] should_filter_by_minimum_capacity", async () => {
    const { body } = await getOptions("coordinator", "&minCapacity=350");

    expect(body.venues.map((venue) => venue.name).sort()).toEqual([`${prefix} Booked`, `${prefix} NoBuffers`]);
  });

  test("[TC-VC-012][SPM-72-AC2] should_give_the_supervising_lead_read_only_options", async () => {
    const response = await getOptions("coordinatorLead");

    expect(response.status).toBe(200);
    expect(response.body.canSuggestVenue).toBe(false);
    expect(byName(response.body, "Fits")).toBeDefined();
  });

  test.each([["coordinatorTwo", 404], ["organiserA", 403], ["venueStaff", 403], ["attendee", 403]])(
    "[TC-VC-013][SPM-72-AC1] should_refuse_%s_with_%i",
    async (key, status) => {
      const response = await getOptions(key);
      expect(response.status).toBe(status);
      expect(response.body).not.toHaveProperty("venues");
    }
  );

  test("[TC-VC-006][SPM-72-AC4] should_serve_photos_of_offered_venues_only", async () => {
    const list = await as("coordinator", request(app).get(`/api/events/${eventId}/venue-options/${venues.fits.venueId}/photos`));
    expect(list.status).toBe(200);
    expect(list.body.photos).toHaveLength(1);

    const image = await as("coordinator", request(app).get(`/api/events/${eventId}/venue-options/${venues.fits.venueId}/photos/${list.body.photos[0].photoId}`));
    expect(image.status).toBe(200);
    expect(image.headers["x-content-type-options"]).toBe("nosniff");

    const hidden = await as("coordinator", request(app).get(`/api/events/${eventId}/venue-options/${venues.inactive.venueId}/photos`));
    expect(hidden.status).toBe(404);
  });
});

describe("PUT /api/events/:id/venue-suggestion (SPM-72)", () => {
  test("[TC-VC-008][SPM-72-AC8] should_suggest_the_venue_log_it_and_tell_the_organiser", async () => {
    const response = await suggest("coordinator", { venueId: venues.fits.venueId, version: 0 }, `${prefix}-first`);

    expect(response.status).toBe(200);
    expect(response.body.suggestion).toEqual(expect.objectContaining({ venueId: venues.fits.venueId, version: 1 }));

    const ownerView = await as("organiserA", request(app).get(`/api/events/${eventId}`));
    expect(ownerView.body.event.venueSuggestion).toEqual(expect.objectContaining({ venueId: venues.fits.venueId, name: `${prefix} Fits` }));
    expect(ownerView.body.event.permissions.canSuggestVenue).toBe(false);

    const history = await as("organiserA", request(app).get(`/api/events/${eventId}/history`));
    expect(history.body.history).toEqual(expect.arrayContaining([expect.objectContaining({ action: "VENUE_SUGGESTED", audience: "ORGANISER_SAFE" })]));

    const { data: notifications, error } = await supabase
      .from("notification")
      .select("type,notification_recipient(recipient_id)")
      .eq("event_id", eventId)
      .eq("type", "VENUE_SUGGESTION");
    expect(error).toBeNull();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].notification_recipient).toEqual([{ recipient_id: fixtures.accounts.organiserA.userId }]);
  });

  test("[TC-VC-010][SPM-72-AC10] should_replay_a_repeated_request_without_a_second_notification", async () => {
    const response = await suggest("coordinator", { venueId: venues.fits.venueId, version: 0 }, `${prefix}-first`);

    expect(response.status).toBe(200);
    expect(response.body.suggestion.version).toBe(1);
    const { count } = await supabase.from("notification").select("notification_id", { count: "exact", head: true })
      .eq("event_id", eventId).eq("type", "VENUE_SUGGESTION");
    expect(count).toBe(1);
  });

  test("[TC-VC-010][SPM-72-AC10] should_refuse_a_stale_version", async () => {
    const response = await suggest("coordinator", { venueId: venues.booked.venueId, version: 0 }, `${prefix}-stale`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("VENUE_SUGGESTION_VERSION_CONFLICT");
  });

  test.each([
    ["small", "VENUE_CAPACITY_TOO_SMALL"],
    ["inactive", "VENUE_NOT_SELECTABLE"],
  ])("[TC-VC-009][SPM-72-AC8] should_refuse_the_%s_venue", async (label, code) => {
    const response = await suggest("coordinator", { venueId: venues[label].venueId, version: 1 }, `${prefix}-${label}`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(code);
  });

  test.each([["coordinatorLead", 403], ["coordinatorTwo", 404], ["organiserA", 403]])(
    "[TC-VC-012][TC-VC-013][SPM-72-AC2] should_refuse_a_suggestion_from_%s",
    async (key, status) => {
      const response = await suggest(key, { venueId: venues.booked.venueId, version: 1 }, `${prefix}-${key}`);
      expect(response.status).toBe(status);
    }
  );

  test("[TC-VC-010][SPM-72-AC10] should_accept_exactly_one_of_two_simultaneous_changes", async () => {
    const [first, second] = await Promise.all([
      suggest("coordinator", { venueId: venues.booked.venueId, version: 1 }, `${prefix}-race-a`),
      suggest("coordinator", { venueId: venues.noBuffers.venueId, version: 1 }, `${prefix}-race-b`),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.code).toBe("VENUE_SUGGESTION_VERSION_CONFLICT");
    const view = await as("coordinator", request(app).get(`/api/events/${eventId}`));
    expect(view.body.event.venueSuggestion.version).toBe(2);
  });
});
