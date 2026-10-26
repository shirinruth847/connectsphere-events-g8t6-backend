// SPM-186 / SPM-189 live integration tests: real routes, Supabase Auth and the
// shared development database, with migration
// 20261024100623_spm186_189_venue_booking_decisions applied. MongoDB is a local
// in-memory server (Master M7). Venues, rooms and bookings are synthetic
// (spm186-<run> ...), recorded in the fixture manifest and removed afterwards;
// the Venue Staff notification of a status change has no event, so this suite
// deletes it by its action key. Audit entries are append-only and are kept.
const request = require("supertest");
const { MongoMemoryServer } = require("mongodb-memory-server");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { applyMigrations } = require("../../mongodb/migrate");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");

jest.setTimeout(180000);

const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const runId = newRunId();
const prefix = `spm186-${runId}`;
let fixtures;
let mongoServer;
const venues = {};
const rooms = {};
const sessions = new Map();
const staffNotificationKeys = [];

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

const approve = (bookingId, body = { expectedStatus: "PENDING" }) =>
  call("venueStaff", "post", `/api/venues/bookings/${bookingId}/approve`, body);
const reject = (bookingId, reason, expectedStatus = "PENDING") =>
  call("venueStaff", "post", `/api/venues/bookings/${bookingId}/reject`, { reason, expectedStatus });

const insertVenue = async (label, row) => {
  const { data, error } = await supabase
    .from("venue")
    .insert({ name: `${prefix} ${label}`, address: `${prefix} ${label} Road`, max_capacity: 150, operating_hours: "08:00-22:00", ...row })
    .select("venue_id,version")
    .single();
  if (error) throw new Error(`Fixture venue ${label} failed: ${error.message}`);
  recordFixtureIds(runId, "venueIds", [data.venue_id]);
  const { data: room, error: roomError } = await supabase
    .from("room").insert({ venue_id: data.venue_id, layout_type: "THEATRE", capacity: 150 }).select("room_id").single();
  if (roomError) throw new Error(`Fixture room ${label} failed: ${roomError.message}`);
  recordFixtureIds(runId, "roomIds", [room.room_id]);
  venues[label] = data.venue_id;
  rooms[label] = room.room_id;
};

const insertBooking = async (venueLabel, eventKey, start, end, overrides = {}) => {
  const { data, error } = await supabase
    .from("venue_booking")
    .insert({
      room_id: rooms[venueLabel],
      event_id: fixtures.events[eventKey],
      requested_by: fixtures.accounts.coordinator.userId,
      start_datetime: start,
      end_datetime: end,
      expected_attendance: 100,
      status: "PENDING",
      ...overrides,
    })
    .select("booking_id")
    .single();
  if (error) throw new Error(`Fixture booking failed: ${error.message}`);
  recordFixtureIds(runId, "bookingIds", [data.booking_id]);
  return data.booking_id;
};

const bookingRow = async (bookingId) => {
  const { data, error } = await supabase
    .from("venue_booking").select("status,rejection_reason,reviewed_by,reviewed_at").eq("booking_id", bookingId).single();
  if (error) throw error;
  return data;
};

const eventRow = async (eventKey) => {
  const { data, error } = await supabase
    .from("event").select("status,arrangement_version").eq("event_id", fixtures.events[eventKey]).single();
  if (error) throw error;
  return data;
};

const notificationsFor = async (keyPrefix) => {
  const { data, error } = await supabase
    .from("notification")
    .select("title,message,type,action_key,recipients:notification_recipient(recipient_id)")
    .like("action_key", `${keyPrefix}%`)
    .order("notification_id", { ascending: true });
  if (error) throw error;
  return data;
};

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  process.env.MONGODB_DB_NAME = `spm186_${runId}`;

  fixtures = await createAuthFixtures(runId);
  await insertVenue("Main", {});
  await insertVenue("NoMinutes", {});
  await insertVenue("Small", { max_capacity: 40 });
  await insertVenue("Closing", {});

  const db = await getMongoDb();
  await applyMigrations(db);
  const detail = (label, minutes) => ({
    _id: String(venues[label]),
    pg_version: 1,
    name: `${prefix} ${label}`,
    location: `${prefix} ${label} Road`,
    ...minutes,
  });
  await db.collection("venue_details").insertMany([
    detail("Main", { setupMinutes: 30, turnaroundMinutes: 45 }),
    detail("NoMinutes", {}),
    detail("Small", { setupMinutes: 0, turnaroundMinutes: 0 }),
    detail("Closing", { setupMinutes: 0, turnaroundMinutes: 0 }),
  ]);
});

afterAll(async () => {
  try {
    for (const key of staffNotificationKeys) {
      await supabase.from("notification").delete().eq("action_key", key);
    }
    await cleanupAuthFixtures(runId);
  } finally {
    await closeMongoDb();
    if (mongoServer) await mongoServer.stop();
    process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
    process.env.MONGODB_DB_NAME = ORIGINAL_MONGODB_DB_NAME;
  }
});

describe("SPM-186 approve a venue booking", () => {
  test("[SPM-186-AC1][SPM-186-AC2] should_approve_one_booking_record_who_and_when_and_leave_the_others", async () => {
    const target = await insertBooking("Main", "reassignable", "2027-03-10T10:00:00Z", "2027-03-10T11:00:00Z");
    const sibling = await insertBooking("Closing", "reassignable", "2027-03-10T11:00:00Z", "2027-03-10T12:00:00Z");
    const before = await eventRow("reassignable");

    const response = await approve(target);

    expect(response.status).toBe(200);
    expect(response.body.booking).toEqual(expect.objectContaining({
      bookingId: target,
      status: "APPROVED",
      statusLabel: "Approved",
      actions: { canApprove: false, canReject: true },
    }));
    expect(response.body.booking.reviewedAt).toEqual(expect.any(String));
    expect(response.body.otherBookings).toEqual(expect.arrayContaining([expect.objectContaining({ bookingId: sibling, status: "PENDING" })]));

    const row = await bookingRow(target);
    expect(row.status).toBe("APPROVED");
    expect(row.reviewed_by).toBe(fixtures.accounts.venueStaff.userId);
    expect(row.reviewed_at).not.toBeNull();
    expect((await bookingRow(sibling)).status).toBe("PENDING");

    const after = await eventRow("reassignable");
    expect(after.status).toBe("PLANNING");
    expect(after.arrangement_version).toBe(before.arrangement_version + 1);

    const sent = await notificationsFor(`VENUE_BOOKING_APPROVED:${target}:`);
    expect(sent.map(({ action_key: key, recipients }) => [key.split(":").pop(), recipients.map(({ recipient_id: id }) => id)])).toEqual([
      ["COORDINATOR", [fixtures.accounts.coordinator.userId]],
      ["OWNER", [fixtures.accounts.organiserA.userId]],
    ]);
  });

  test("[SPM-186-AC3] should_drop_the_booking_from_the_pending_list_and_keep_the_event's_other_pending_bookings", async () => {
    const list = await call("venueStaff", "get", `/api/venues/bookings?status=PENDING&eventId=${fixtures.events.reassignable}`);

    expect(list.status).toBe(200);
    expect(list.body.bookings.every(({ status }) => status === "PENDING")).toBe(true);
    expect(list.body.bookings.length).toBeGreaterThanOrEqual(1);
  });

  test("[SPM-186-AC5] should_apply_only_one_of_two_simultaneous_decisions", async () => {
    const target = await insertBooking("Main", "reassignable", "2027-03-10T06:00:00Z", "2027-03-10T07:00:00Z");

    const responses = await Promise.all([approve(target), reject(target, "Double-booked by phone")]);

    const statuses = responses.map(({ status }) => status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = responses.find(({ status }) => status === 409);
    expect(loser.body.code).toBe("BOOKING_ALREADY_DECIDED");
    expect(["APPROVED", "REJECTED"]).toContain(loser.body.currentStatus);
  });

  test("[SPM-186-AC4] should_refuse_approving_a_booking_that_was_already_decided", async () => {
    const target = await insertBooking("Small", "reassignable", "2027-03-10T13:00:00Z", "2027-03-10T14:00:00Z", { expected_attendance: 20 });
    expect((await approve(target)).status).toBe(200);

    const again = await approve(target, {});

    expect(again.status).toBe(409);
    expect(again.body).toEqual(expect.objectContaining({ code: "BOOKING_ALREADY_DECIDED", currentStatus: "APPROVED" }));
  });

  test("[Master 5.4.1] should_refuse_an_overlap_within_turnaround_and_allow_the_adjacent_start", async () => {
    // Main is 30 min setup and 45 min turnaround: 10:00-12:00 occupies [09:30, 12:45).
    const first = await insertBooking("Main", "registeredPlanning", "2027-05-01T10:00:00Z", "2027-05-01T12:00:00Z");
    const overlapping = await insertBooking("Main", "reassignable", "2027-05-01T13:14:00Z", "2027-05-01T14:00:00Z");
    const adjacent = await insertBooking("Main", "reassignable", "2027-05-01T13:15:00Z", "2027-05-01T14:00:00Z");
    expect((await approve(first)).status).toBe(200);

    const conflict = await approve(overlapping);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("VENUE_BOOKING_CONFLICT");
    expect((await approve(adjacent)).status).toBe(200);
  });

  test.each([
    ["NoMinutes", "reassignable", {}, "VENUE_BUFFERS_NOT_SET"],
    ["Small", "reassignable", { expected_attendance: 41 }, "VENUE_CAPACITY_EXCEEDED"],
    ["Main", "registeredConfirmed", {}, "EVENT_NOT_IN_PLANNING"],
  ])("should_refuse_approval_at_%s_for_%s_with_%#", async (venueLabel, eventKey, overrides, code) => {
    const target = await insertBooking(venueLabel, eventKey, "2027-06-01T10:00:00Z", "2027-06-01T11:00:00Z", overrides);

    const response = await approve(target);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(code);
    expect((await bookingRow(target)).status).toBe("PENDING");
  });

  test("[SPM-181-AC7] should_refuse_other_roles_and_hide_unknown_bookings", async () => {
    const target = await insertBooking("Main", "reassignable", "2027-07-01T10:00:00Z", "2027-07-01T11:00:00Z");

    expect((await call("coordinator", "post", `/api/venues/bookings/${target}/approve`, {})).status).toBe(403);
    expect((await call("organiserA", "post", `/api/venues/bookings/${target}/reject`, { reason: "x", expectedStatus: "PENDING" })).status).toBe(403);
    expect((await approve(2147483000)).status).toBe(404);
    expect((await bookingRow(target)).status).toBe("PENDING");
  });
});

describe("SPM-189 reject a venue booking", () => {
  test("[SPM-189-AC2] should_not_save_a_rejection_without_a_reason", async () => {
    const target = await insertBooking("Main", "reassignable", "2027-08-01T10:00:00Z", "2027-08-01T11:00:00Z");

    const response = await reject(target, "   ");

    expect(response.status).toBe(400);
    expect(response.body.fields.reason).toEqual(expect.any(String));
    expect((await bookingRow(target)).status).toBe("PENDING");
  });

  test("[SPM-189-AC3][SPM-189-AC4][SPM-189-AC5] should_record_the_reason_with_alternatives_and_leave_the_event_and_other_bookings", async () => {
    const target = await insertBooking("Main", "reassignable", "2027-08-02T10:00:00Z", "2027-08-02T11:00:00Z");
    const sibling = await insertBooking("Closing", "reassignable", "2027-08-02T11:00:00Z", "2027-08-02T12:00:00Z");
    const reason = "Projector bay closed that week. Alternatives: Hall B on 3 Aug, or 9 Aug here.";

    const response = await reject(target, reason);

    expect(response.status).toBe(200);
    expect(response.body.booking).toEqual(expect.objectContaining({ status: "REJECTED", rejectionReason: reason, actions: { canApprove: false, canReject: false } }));
    const row = await bookingRow(target);
    expect(row).toEqual(expect.objectContaining({ status: "REJECTED", rejection_reason: reason, reviewed_by: fixtures.accounts.venueStaff.userId }));
    expect((await bookingRow(sibling)).status).toBe("PENDING");
    expect((await eventRow("reassignable")).status).toBe("PLANNING");

    const [coordinatorNotice, ownerNotice] = await notificationsFor(`VENUE_BOOKING_REJECTED:${target}:PENDING:`);
    expect(coordinatorNotice.message).toContain(reason);
    expect(ownerNotice.message).not.toContain(reason);
  });

  test("[SPM-189-AC6] should_refuse_rejecting_a_booking_that_is_already_rejected", async () => {
    const target = await insertBooking("Main", "reassignable", "2027-08-03T10:00:00Z", "2027-08-03T11:00:00Z");
    expect((await reject(target, "No staff that day")).status).toBe(200);

    const again = await reject(target, "Second attempt", "PENDING");

    expect(again.status).toBe(409);
    expect(again.body).toEqual(expect.objectContaining({ code: "BOOKING_ALREADY_DECIDED", currentStatus: "REJECTED" }));
  });

  test("[T32] should_reject_an_approved_future_booking_and_keep_the_confirmed_event", async () => {
    const target = await insertBooking("Closing", "registeredConfirmed", "2027-09-01T10:00:00Z", "2027-09-01T11:00:00Z", { status: "APPROVED" });
    const before = await eventRow("registeredConfirmed");

    const response = await reject(target, "Emergency roof repair", "APPROVED");

    expect(response.status).toBe(200);
    expect((await bookingRow(target)).status).toBe("REJECTED");
    const after = await eventRow("registeredConfirmed");
    expect(after.status).toBe("CONFIRMED");
    expect(after.arrangement_version).toBe(before.arrangement_version + 1);
    const sent = await notificationsFor(`VENUE_BOOKING_REJECTED:${target}:APPROVED:`);
    expect(sent.map(({ title }) => title)).toEqual(["Venue no longer available", "Venue no longer available"]);
    expect(sent[1].message).toContain("not cancelled");
  });

  test("[T32] should_refuse_rejecting_an_approved_booking_that_has_started", async () => {
    const target = await insertBooking("Small", "registeredPlanning", "2020-01-01T10:00:00Z", "2099-01-01T11:00:00Z", {
      status: "APPROVED", expected_attendance: 20,
    });

    const response = await reject(target, "Too late", "APPROVED");

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("BOOKING_ALREADY_STARTED");
  });
});

describe("Venue taken out of service with upcoming bookings (Master 5.4.4, T32)", () => {
  test("should_warn_with_the_affected_events_then_keep_bookings_and_alert_coordinators_and_organisers", async () => {
    const pending = await insertBooking("Closing", "reassignable", "2027-10-01T10:00:00Z", "2027-10-01T11:00:00Z");
    const { data: venue } = await supabase.from("venue").select("version").eq("venue_id", venues.Closing).single();
    const before = await eventRow("reassignable");

    const warning = await call("venueStaff", "put", `/api/venues/${venues.Closing}/status`, {
      status: "UNDER_MAINTENANCE", reason: "Air-conditioning failure", version: venue.version,
    });

    expect(warning.status).toBe(409);
    expect(warning.body.code).toBe("VENUE_HAS_UPCOMING_BOOKINGS");
    expect(warning.body.affectedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: fixtures.events.reassignable, requestId: expect.stringMatching(/^REQ-\d{6}$/) }),
    ]));
    // Venue Staff see which events are affected, never organiser or participant details (Master 4.2).
    for (const item of warning.body.affectedEvents) {
      expect(Object.keys(item).sort()).toEqual(["bookings", "eventId", "firstStart", "requestId", "status", "title"]);
    }

    const confirmed = await call("venueStaff", "put", `/api/venues/${venues.Closing}/status`, {
      status: "UNDER_MAINTENANCE", reason: "Air-conditioning failure", version: venue.version, confirmUpcomingBookings: true,
    });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.venue.status).toBe("UNDER_MAINTENANCE");
    expect(confirmed.body.affectedEvents.length).toBeGreaterThanOrEqual(1);
    staffNotificationKeys.push(`VENUE_UNAVAILABLE:${venues.Closing}:${confirmed.body.venue.version}:STAFF`);

    expect((await bookingRow(pending)).status).toBe("PENDING");
    const after = await eventRow("reassignable");
    expect(after.status).toBe("PLANNING");
    expect(after.arrangement_version).toBe(before.arrangement_version + 1);

    const sent = await notificationsFor(`VENUE_UNAVAILABLE:${venues.Closing}:${confirmed.body.venue.version}:${fixtures.events.reassignable}:`);
    expect(sent.map(({ action_key: key, recipients }) => [key.split(":").pop(), recipients.map(({ recipient_id: id }) => id)])).toEqual([
      ["COORDINATOR", [fixtures.accounts.coordinator.userId]],
      ["OWNER", [fixtures.accounts.organiserA.userId]],
    ]);
    expect(sent[0].message).toContain("Air-conditioning failure");
    expect(sent[1].message).not.toContain("Air-conditioning failure");
  });

  test("should_refuse_approving_a_pending_booking_at_a_venue_out_of_service", async () => {
    const target = await insertBooking("Closing", "reassignable", "2027-10-02T10:00:00Z", "2027-10-02T11:00:00Z");

    const response = await approve(target);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("VENUE_NOT_AVAILABLE");
  });
});
