// SPM-247 to SPM-251 through the API on the shared database: queue, claims,
// hand-backs, decisions, supersession and outcome visibility (SPM-243 TC-05 to
// TC-24). MongoDB venue_details comes from an in-memory replica set (Master M7).
// Needs TEST_DATABASE_URL and the SPM-243 migrations.
const crypto = require("crypto");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { withPrivilegedDb, cleanupLifecycleRows } = require("../fixtures/lifecycleFixtures");
const { SAFETY_ACCOUNTS, createReviewEvent } = require("../fixtures/safetyFixtures");

jest.setTimeout(240000);

const FACTORS = ["attendanceCapacity", "layout", "emergencyAccess", "accessibility", "equipmentPlacement", "venueRestrictions"];
const checklist = (overrides = {}) => ({
  ...Object.fromEntries(FACTORS.map((factor) => [factor, { result: "SATISFACTORY", comment: "" }])),
  ...overrides,
});

const runId = newRunId();
const eventIds = [];
let fixtures;
let replSet;
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed.`);
      return session;
    }));
  }
  return sessions.get(key);
};

const call = async (method, path, key, body, headers = {}) => {
  const session = await signIn(key);
  let req = request(app)[method](path).set("Authorization", `Bearer ${session.access_token}`);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

const decide = (reviewId, key, body, idempotencyKey = crypto.randomUUID()) =>
  call("post", `/api/safety-reviews/${reviewId}/decision`, key, body, { "Idempotency-Key": idempotencyKey });

const userId = (key) => fixtures.accounts[key].userId;

const check = ({ data, error }, step) => {
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};

// Approved bookings reviewed by the fixture Venue Staff, and approved equipment
// reviewed by Technical Support, so decisions have staff to notify.
// An event has at most one active booking per venue (Master 6.3, enforced since
// SPM-179), so every booking after the first uses an extra fixture venue.
const extraRoomIds = [];
const roomForBooking = async (index) => {
  if (index === 0) return fixtures.venue.roomId;
  while (extraRoomIds.length < index) {
    const number = extraRoomIds.length + 1;
    const venue = check(
      await supabase.from("venue")
        .insert({ name: `spm32-${runId} Extra ${number}`, address: `spm32-${runId} ${number} Extra Road`, max_capacity: 500 })
        .select("venue_id").single(),
      "extra venue"
    );
    recordFixtureIds(runId, "venueIds", [venue.venue_id]);
    const room = check(
      await supabase.from("room").insert({ venue_id: venue.venue_id, layout_type: "THEATRE", capacity: 500 }).select("room_id").single(),
      "extra room"
    );
    recordFixtureIds(runId, "roomIds", [room.room_id]);
    extraRoomIds.push(room.room_id);
  }
  return extraRoomIds[index - 1];
};

const addArrangements = async (event, bookingCount = 1) => {
  const roomIds = [];
  for (let index = 0; index < bookingCount; index += 1) roomIds.push(await roomForBooking(index));
  const bookings = check(
    await supabase
      .from("venue_booking")
      .insert(roomIds.map((roomId) => ({
        event_id: event.event_id,
        room_id: roomId,
        requested_by: userId("coordinator"),
        reviewed_by: userId("venueStaff"),
        start_datetime: event.start_datetime,
        end_datetime: event.end_datetime,
        status: "APPROVED",
      })))
      .select("booking_id")
      .order("booking_id"),
    "bookings"
  );
  recordFixtureIds(runId, "bookingIds", bookings.map((booking) => booking.booking_id));
  check(
    await supabase.from("equipment_request").insert({
      event_id: event.event_id,
      equipment_id: fixtures.equipmentId,
      requested_by: userId("coordinator"),
      reviewed_by: userId("techSupport"),
      quantity_requested: 1,
      start_datetime: event.start_datetime,
      end_datetime: event.end_datetime,
      status: "APPROVED",
      technical_notes: "Stage left",
    }),
    "equipment"
  );
  return bookings.map((booking) => booking.booking_id);
};

const heldReview = async (options = {}) => {
  const created = await createReviewEvent(fixtures, eventIds, { round: { claimedBy: userId("safetyOfficer"), ...options.round }, event: options.event });
  const bookingIds = await addArrangements(created.event, options.bookings);
  return { ...created, bookingIds };
};

const state = async (eventId, reviewId) => ({
  event: check(await supabase.from("event").select("status,arrangement_version").eq("event_id", eventId).single(), "event"),
  round: check(await supabase.from("safety_reviews").select("status,claimed_by,checklist").eq("review_id", reviewId).single(), "round"),
});

const recipientsOf = async (eventId) => {
  const notices = check(await supabase.from("notification").select("title,notification_recipient(recipient_id)").eq("event_id", eventId), "notifications");
  return notices.flatMap((notice) => notice.notification_recipient.map((row) => ({ title: notice.title, recipientId: row.recipient_id })));
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = `spm243_${runId}`;
  await require("../fixtures/adminCleanup").assertAuditCleanupAvailable();
  fixtures = await createAuthFixtures(runId, { extraAccounts: [...SAFETY_ACCOUNTS] });
  const db = await getMongoDb();
  await db.collection("venue_details").insertOne({
    _id: String(fixtures.venue.venueId), pg_version: 1, name: "Hall", location: "1 Test Road",
    emergencyAccess: "Two exits on the east wall.", knownRestrictions: ["No open flames"],
  });
});

afterAll(async () => {
  if (fixtures) await cleanupLifecycleRows(runId, eventIds);
  await cleanupAuthFixtures(runId);
  await closeMongoDb();
  if (replSet) await replSet.stop();
});

describe("SPM-247 queue, claim and hand-back", () => {
  test("[SPM-243-TC-05] the queue lists open unclaimed rounds oldest first; a claim moves one to My reviews", async () => {
    const created = [];
    for (const minutesAgo of [30, 20, 10]) {
      created.push(await createReviewEvent(fixtures, eventIds, { round: { submittedAt: new Date(Date.now() - minutesAgo * 60000).toISOString() } }));
    }
    const ours = (list) => list.filter((item) => created.some(({ review }) => review.review_id === item.reviewId)).map((item) => item.reviewId);

    const queue = await call("get", "/api/safety-reviews/queue", "safetyOfficer");
    expect(queue.status).toBe(200);
    expect(ours(queue.body.reviews)).toEqual(created.map(({ review }) => review.review_id));
    expect(queue.body.reviews.find((item) => item.reviewId === created[0].review.review_id)).toMatchObject({
      eventId: created[0].event.event_id, title: created[0].event.title, roundNumber: 1, expectedAttendance: 50,
    });

    const middle = created[1].review.review_id;
    expect((await call("post", `/api/safety-reviews/${middle}/claim`, "safetyOfficer", {})).status).toBe(200);
    expect(ours((await call("get", "/api/safety-reviews/queue", "safetyOfficer")).body.reviews)).not.toContain(middle);
    expect(ours((await call("get", "/api/safety-reviews/mine", "safetyOfficer")).body.reviews)).toEqual([middle]);
    expect((await call("get", `/api/events/${created[1].event.event_id}`, "safetyOfficer")).status).toBe(200);
  });

  test("[SPM-243-TC-06] of two simultaneous claims one wins and the other gets 409", async () => {
    const { review } = await createReviewEvent(fixtures, eventIds);
    const results = await Promise.all([
      call("post", `/api/safety-reviews/${review.review_id}/claim`, "safetyOfficer", {}),
      call("post", `/api/safety-reviews/${review.review_id}/claim`, "safetyOfficerTwo", {}),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const winner = results.find((res) => res.status === 200).body.review.claimedBy;
    expect((await state(review.event_id, review.review_id)).round.claimed_by).toBe(winner);
  });

  test("[SPM-243-TC-07][TC-08] hand-back clears progress, keeps SO1's view, and only the claimant may do it", async () => {
    const { event, review } = await heldReview();
    expect((await call("put", `/api/safety-reviews/${review.review_id}/progress`, "safetyOfficer", { checklist: { layout: { result: "SATISFACTORY" } } })).status).toBe(200);
    expect((await call("post", `/api/safety-reviews/${review.review_id}/hand-back`, "safetyOfficerTwo", {})).status).toBe(403);

    const handBack = await call("post", `/api/safety-reviews/${review.review_id}/hand-back`, "safetyOfficer", { note: "Away tomorrow" });
    expect(handBack.status).toBe(200);
    expect((await state(event.event_id, review.review_id)).round).toEqual({ status: "OPEN", claimed_by: null, checklist: null });
    expect((await call("get", `/api/events/${event.event_id}`, "safetyOfficer")).status).toBe(200);
    expect((await call("put", `/api/safety-reviews/${review.review_id}/progress`, "safetyOfficer", { internalNotes: "x" })).status).toBe(403);
    expect((await call("post", `/api/safety-reviews/${review.review_id}/claim`, "safetyOfficerTwo", {})).status).toBe(200);

    const history = await call("get", `/api/events/${event.event_id}/history`, "coordinator");
    expect(history.body.history.map((entry) => entry.action)).toEqual(expect.arrayContaining(["SAFETY_REVIEW_CLAIMED", "SAFETY_REVIEW_HANDED_BACK"]));

    const decided = await heldReview();
    expect((await decide(decided.review.review_id, "safetyOfficer", { outcome: "APPROVED", checklist: checklist(), arrangementVersion: decided.event.arrangement_version })).status).toBe(200);
    expect((await call("post", `/api/safety-reviews/${decided.review.review_id}/hand-back`, "safetyOfficer", {})).status).toBe(409);
  });
});

describe("SPM-248 review panel", () => {
  test("[SPM-243-TC-09] the claimant sees bookings, equipment, rounds and the venue's safety detail", async () => {
    const { review } = await heldReview();
    const res = await call("get", `/api/safety-reviews/${review.review_id}/panel`, "safetyOfficer");
    expect(res.status).toBe(200);
    expect(res.body.venueDetailsAvailable).toBe(true);
    expect(res.body.venueDetails).toEqual([{ venueId: fixtures.venue.venueId, found: true, emergencyAccess: "Two exits on the east wall.", knownRestrictions: ["No open flames"] }]);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.equipment).toEqual([expect.objectContaining({ placement: "Stage left", status: "APPROVED" })]);
    expect((await call("get", `/api/safety-reviews/${review.review_id}/panel`, "safetyOfficerTwo")).status).toBe(404);
  });
});

describe("SPM-249 decisions", () => {
  test("[SPM-243-TC-12][TC-22] approval keeps SAFETY_REVIEW, notifies coordinator and staff, and replays without duplicates", async () => {
    const { event, review } = await heldReview();
    const key = crypto.randomUUID();
    const body = { outcome: "APPROVED", checklist: checklist(), organiserComment: "All clear.", internalNotes: "Checked with venue.", arrangementVersion: event.arrangement_version };
    const first = await decide(review.review_id, "safetyOfficer", body, key);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ review: { status: "APPROVED", decidedBy: userId("safetyOfficer") }, event: { status: "SAFETY_REVIEW" } });
    const replay = await decide(review.review_id, "safetyOfficer", body, key);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");

    const recipients = await recipientsOf(event.event_id);
    expect(recipients.map((row) => row.recipientId).sort()).toEqual([userId("coordinator"), userId("venueStaff"), userId("techSupport")].sort());
    const history = await call("get", `/api/events/${event.event_id}/history`, "coordinator");
    expect(history.body.history.filter((entry) => entry.action === "SAFETY_REVIEW_APPROVED")).toHaveLength(1);
  });

  test("[SPM-243-TC-13][TC-17] a NOT_SATISFACTORY approval and a non-claimant are refused", async () => {
    const { event, review } = await heldReview();
    const unsatisfied = await decide(review.review_id, "safetyOfficer", {
      outcome: "APPROVED", checklist: checklist({ layout: { result: "NOT_SATISFACTORY", comment: "Blocked exit" } }), arrangementVersion: event.arrangement_version,
    });
    expect(unsatisfied.status).toBe(409);
    expect(unsatisfied.body).toMatchObject({ code: "SAFETY_FACTOR_NOT_SATISFACTORY", factors: ["layout"] });
    const other = await decide(review.review_id, "safetyOfficerTwo", { outcome: "APPROVED", checklist: checklist(), arrangementVersion: event.arrangement_version });
    expect(other.status).toBe(403);
    expect((await state(event.event_id, review.review_id)).round.status).toBe("OPEN");
  });

  test("[SPM-243-TC-14] changes requested returns the event to PLANNING and keeps every arrangement", async () => {
    const { event, review, bookingIds } = await heldReview();
    const res = await decide(review.review_id, "safetyOfficer", {
      outcome: "CHANGES_REQUESTED",
      checklist: checklist({ layout: { result: "NOT_SATISFACTORY", comment: "Aisles too narrow" } }),
      requestedChanges: ["Widen the aisles", "Add exit signs"],
      arrangementVersion: event.arrangement_version,
    });
    expect(res.status).toBe(200);
    expect((await state(event.event_id, review.review_id)).event.status).toBe("PLANNING");
    const bookings = check(await supabase.from("venue_booking").select("status").in("booking_id", bookingIds), "bookings");
    expect(bookings.every((booking) => booking.status === "APPROVED")).toBe(true);
    const outcomes = await call("get", `/api/events/${event.event_id}/safety-reviews`, "coordinator");
    expect(outcomes.body.reviews[0].requestedChanges).toEqual(["Widen the aisles", "Add exit signs"]);
  });

  test("[SPM-243-TC-15][TC-16] rejection names one booking of this event; nothing is released", async () => {
    const { event, review, bookingIds } = await heldReview({ bookings: 3 });
    const other = await heldReview();
    const base = { outcome: "REJECTED", checklist: checklist({ venueRestrictions: { result: "NOT_SATISFACTORY", comment: "No exit" } }), arrangementVersion: event.arrangement_version };
    expect((await decide(review.review_id, "safetyOfficer", { ...base, rejectedBookings: [] })).status).toBe(400);
    const foreign = await decide(review.review_id, "safetyOfficer", { ...base, rejectedBookings: [{ bookingId: other.bookingIds[0], reason: "Unsafe" }] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.fields).toHaveProperty("rejectedBookings");

    const res = await decide(review.review_id, "safetyOfficer", { ...base, rejectedBookings: [{ bookingId: bookingIds[1], reason: "No second exit" }] });
    expect(res.status).toBe(200);
    expect(res.body.review.rejectedBookings).toEqual([{ bookingId: bookingIds[1], reason: "No second exit" }]);
    expect((await state(event.event_id, review.review_id)).event.status).toBe("PLANNING");
    const bookings = check(await supabase.from("venue_booking").select("booking_id,status").in("booking_id", bookingIds), "bookings");
    expect(bookings.map((booking) => booking.status)).toEqual(["APPROVED", "APPROVED", "APPROVED"]);
  });

  test("[SPM-243-TC-20] the decision is refused with a retry message while venue details cannot be read", async () => {
    const { event, review } = await heldReview();
    await closeMongoDb();
    const uri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    try {
      const res = await decide(review.review_id, "safetyOfficer", { outcome: "APPROVED", checklist: checklist(), arrangementVersion: event.arrangement_version });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("VENUE_DETAILS_UNAVAILABLE");
    } finally {
      process.env.MONGODB_URI = uri;
    }
    expect((await state(event.event_id, review.review_id)).round.status).toBe("OPEN");
  });

  test("[SPM-243-TC-21] a failed notification saves nothing", async () => {
    const { event, review } = await heldReview();
    await withPrivilegedDb(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`CREATE FUNCTION public.spm243_fail_${runId}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END; $$`);
        await client.query(`CREATE TRIGGER spm243_fail_notification BEFORE INSERT ON public.notification FOR EACH ROW EXECUTE FUNCTION public.spm243_fail_${runId}()`);
        await client.query("SAVEPOINT attempt");
        await expect(client.query(
          "SELECT public.decide_safety_review($1, $2, $3::jsonb, $4, NULL, NULL)",
          [review.review_id, userId("safetyOfficer"), JSON.stringify({ outcome: "APPROVED", checklist: checklist() }), event.arrangement_version]
        )).rejects.toThrow("forced failure");
        await client.query("ROLLBACK TO SAVEPOINT attempt");
        const { rows } = await client.query(
          `SELECT r.status, (SELECT count(*) FROM public.activity_log a WHERE a.entity_name = 'event' AND a.entity_id = r.event_id AND a.action = 'SAFETY_REVIEW_APPROVED') AS history
             FROM public.safety_reviews r WHERE r.review_id = $1`,
          [review.review_id]
        );
        expect(rows[0]).toEqual({ status: "OPEN", history: "0" });
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });
});

describe("SPM-250 supersession", () => {
  test("[SPM-243-TC-18] a venue block supersedes the open round; the officer's decision is then refused", async () => {
    const { event, review } = await heldReview();
    check(await supabase.rpc("record_arrangement_change", { p_event_id: event.event_id, p_actor_id: userId("venueStaff"), p_reason: "Venue blocked for maintenance." }), "arrangement change");
    expect(await state(event.event_id, review.review_id)).toMatchObject({ event: { status: "PLANNING", arrangement_version: event.arrangement_version + 1 }, round: { status: "SUPERSEDED" } });
    const res = await decide(review.review_id, "safetyOfficer", { outcome: "APPROVED", checklist: checklist(), arrangementVersion: event.arrangement_version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ROUND_NOT_OPEN");
    expect((await recipientsOf(event.event_id)).map((row) => row.recipientId).sort()).toEqual([userId("coordinator"), userId("safetyOfficer")].sort());
  });

  test("[SPM-243-AC11] a version raised without superseding is caught by the decision", async () => {
    const { event, review } = await heldReview();
    await withPrivilegedDb((client) => client.query("UPDATE public.event SET arrangement_version = arrangement_version + 1 WHERE event_id = $1", [event.event_id]));
    const res = await decide(review.review_id, "safetyOfficer", { outcome: "APPROVED", checklist: checklist(), arrangementVersion: event.arrangement_version });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ARRANGEMENTS_CHANGED", currentStatus: "PLANNING", review: { status: "SUPERSEDED" } });
  });

  test("[SPM-243-AC13] a decision racing an arrangement change on another connection: one wins, the other gets 409", async () => {
    const { event, review } = await heldReview();
    let decision;
    await withPrivilegedDb(async (client) => {
      await client.query("BEGIN");
      await client.query("SELECT public.record_arrangement_change($1, NULL, 'Attendance changed.')", [event.event_id]);
      decision = decide(review.review_id, "safetyOfficer", { outcome: "APPROVED", checklist: checklist(), arrangementVersion: event.arrangement_version });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await client.query("COMMIT");
    });
    const res = await decision;
    expect(res.status).toBe(409);
    expect((await state(event.event_id, review.review_id)).round.status).toBe("SUPERSEDED");
  });

  test("[SPM-243-TC-19] an attendance change after approval voids it and returns the event to PLANNING", async () => {
    const { event, review } = await heldReview();
    expect((await decide(review.review_id, "safetyOfficer", { outcome: "APPROVED", checklist: checklist(), arrangementVersion: event.arrangement_version })).status).toBe(200);
    check(await supabase.rpc("record_arrangement_change", { p_event_id: event.event_id, p_actor_id: userId("coordinator"), p_reason: "Expected attendance changed." }), "arrangement change");
    expect(await state(event.event_id, review.review_id)).toMatchObject({ event: { status: "PLANNING" }, round: { status: "APPROVED" } });
    const notice = (await recipientsOf(event.event_id)).filter((row) => row.title === "Safety review superseded");
    expect(notice.map((row) => row.recipientId)).toContain(userId("coordinator"));
  });
});

describe("SPM-251 outcome visibility", () => {
  test("[SPM-243-TC-23][TC-24] each role sees its portion; every round is shown in order", async () => {
    const { event, review, bookingIds } = await heldReview();
    expect((await decide(review.review_id, "safetyOfficer", {
      outcome: "CHANGES_REQUESTED", checklist: checklist({ layout: { result: "NOT_SATISFACTORY", comment: "Narrow" } }),
      requestedChanges: ["Widen aisles"], organiserComment: "Please widen the aisles.", internalNotes: "Fire officer concerned.",
      arrangementVersion: event.arrangement_version,
    })).status).toBe(200);
    // Round 2, opened directly in place of SPM-173's resubmission, then rejected.
    await withPrivilegedDb((client) => client.query("UPDATE public.event SET status = 'SAFETY_REVIEW' WHERE event_id = $1", [event.event_id]));
    const second = check(await supabase.from("safety_reviews").insert({
      event_id: event.event_id, round_number: 2, arrangement_version: event.arrangement_version,
      submitted_by: userId("coordinator"), claimed_by: userId("safetyOfficer"), claimed_at: new Date().toISOString(),
    }).select("review_id").single(), "round 2");
    expect((await decide(second.review_id, "safetyOfficer", {
      outcome: "REJECTED", checklist: checklist({ venueRestrictions: { result: "NOT_SATISFACTORY", comment: "No exit" } }),
      rejectedBookings: [{ bookingId: bookingIds[0], reason: "No second exit" }], arrangementVersion: event.arrangement_version,
    })).status).toBe(200);

    const coordinator = await call("get", `/api/events/${event.event_id}/safety-reviews`, "coordinator");
    expect(coordinator.body.reviews.map((round) => [round.roundNumber, round.status])).toEqual([[1, "CHANGES_REQUESTED"], [2, "REJECTED"]]);
    expect(coordinator.body.reviews[0]).toMatchObject({ internalNotes: "Fire officer concerned.", checklist: expect.any(Object) });

    const organiser = await call("get", `/api/events/${event.event_id}/safety-reviews`, "organiserA");
    expect(organiser.status).toBe(200);
    expect(organiser.body.reviews[0]).toEqual({ roundNumber: 1, status: "CHANGES_REQUESTED", decidedAt: expect.any(String), organiserComment: "Please widen the aisles." });
    expect(JSON.stringify(organiser.body)).not.toMatch(/Fire officer|Narrow|No second exit/);

    const lead = await call("get", `/api/events/${event.event_id}/safety-reviews`, "coordinatorLead");
    expect(lead.body.reviews[1]).toEqual({ roundNumber: 2, status: "REJECTED", decidedAt: expect.any(String) });
    const venueStaff = await call("get", `/api/events/${event.event_id}/safety-reviews`, "venueStaff");
    expect(venueStaff.body.reviews[1].rejectedBookings).toEqual([{ bookingId: bookingIds[0], reason: "No second exit" }]);
    const techSupport = await call("get", `/api/events/${event.event_id}/safety-reviews`, "techSupport");
    expect(techSupport.body.reviews[0]).toEqual({ roundNumber: 1, status: "CHANGES_REQUESTED", decidedAt: expect.any(String) });
    expect((await call("get", `/api/events/${event.event_id}/safety-reviews`, "attendee")).status).toBe(404);
  });

  test("[SPM-243-AC15] staff outside the event's arrangements, and Leads outside their supervision, get 404", async () => {
    // Under review, but no booking or equipment request reviewed by this Venue Staff or Technical Support.
    const { event } = await createReviewEvent(fixtures, eventIds, { round: {} });
    for (const key of ["venueStaff", "techSupport"]) {
      const res = await call("get", `/api/events/${event.event_id}/safety-reviews`, key);
      expect([key, res.status, res.body.code]).toEqual([key, 404, "EVENT_NOT_FOUND"]);
    }
    const lead = await call("get", `/api/events/${event.event_id}/safety-reviews`, "coordinatorLead");
    expect(lead.status).toBe(200);
    expect(lead.body.reviews).toEqual([{ roundNumber: 1, status: "OPEN", decidedAt: null }]);

    // Master 4.2: a Lead reads the outcome only of events they supervise.
    const { event: unsupervised } = await createReviewEvent(fixtures, eventIds, { round: {}, supervisedBy: null });
    const leadUnsupervised = await call("get", `/api/events/${unsupervised.event_id}/safety-reviews`, "coordinatorLead");
    expect([leadUnsupervised.status, leadUnsupervised.body.code]).toEqual([404, "EVENT_NOT_FOUND"]);

    const { event: draft } = await createReviewEvent(fixtures, eventIds, { status: "DRAFT", round: null });
    const leadOnDraft = await call("get", `/api/events/${draft.event_id}/safety-reviews`, "coordinatorLead");
    expect([leadOnDraft.status, leadOnDraft.body.code]).toEqual([404, "EVENT_NOT_FOUND"]);
  });
});
