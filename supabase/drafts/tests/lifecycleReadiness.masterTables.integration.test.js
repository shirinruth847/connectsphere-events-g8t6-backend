process.env.ENABLE_COORDINATOR_WORKFLOWS = "true";
// SPM-173 readiness, submit for safety review and confirmation (AC8-AC10) on
// the Master resource tables: primary flags, stored occupied ranges, incidents
// and technical requests. Holds and blocks are MongoDB venue_calendar documents
// under Master 1.2 and never count toward readiness; a block reaches readiness
// only through its resource incident. Kept beside the draft migrations it needs
// and NOT run: when
// supabase/drafts/20261019100300 and 20261019100400 are agreed and applied, move
// this file to tests/integration (its require paths assume that location) in
// place of the live-schema readiness suite.
const crypto = require("crypto");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { withPrivilegedDb, createLifecycleEvent, createSafetyRound, cleanupLifecycleRows } = require("../fixtures/lifecycleFixtures");

jest.setTimeout(180000);

const runId = newRunId();
const createdEventIds = [];
let fixtures;
let annexVenueId;
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

const check = ({ data, error }, step) => {
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};

const userId = (key) => fixtures.accounts[key].userId;

// Every event gets its own day, so bookings at the shared fixture venue never
// overlap (the booking exclusion constraint would refuse them).
let nextDay = 0;
const lifecycleEvent = async (overrides = {}) => {
  nextDay += 1;
  const day = String(nextDay).padStart(2, "0");
  const event = await createLifecycleEvent(fixtures, {
    start_datetime: `2027-07-${day}T01:00:00Z`,
    end_datetime: `2027-07-${day}T05:00:00Z`,
    ...overrides,
  });
  createdEventIds.push(event.event_id);
  return event;
};

const addBooking = async (event, { status = "APPROVED", isPrimary = true, venueId = fixtures.venue.venueId, attendance = null } = {}) => {
  const booking = check(
    await supabase
      .from("venue_booking")
      .insert({
        event_id: event.event_id,
        venue_id: venueId,
        requested_by: userId("coordinator"),
        reviewed_by: status === "APPROVED" ? userId("venueStaff") : null,
        start_datetime: event.start_datetime,
        end_datetime: event.end_datetime,
        status,
        is_primary: isPrimary,
        expected_attendance: attendance,
        occupied_range: `[${event.start_datetime},${event.end_datetime})`,
      })
      .select("booking_id")
      .single(),
    "booking"
  );
  recordFixtureIds(runId, "bookingIds", [booking.booking_id]);
  return booking;
};

const addTechnicalRequest = (event, status) =>
  supabase.from("technical_requests").insert({
    event_id: event.event_id,
    status,
    requested_by: userId("coordinator"),
    reviewer_id: status === "PENDING" ? null : userId("techSupport"),
    decided_at: status === "PENDING" ? null : new Date().toISOString(),
  });

// An event in PLANNING that passes every readiness condition.
const readyEvent = async (overrides = {}) => {
  const event = await lifecycleEvent({ is_registration_enabled: true, registration_capacity: 150, ...overrides });
  await addBooking(event);
  check(await addTechnicalRequest(event, "APPROVED"), "technical request");
  return event;
};

const readinessCodes = (res) => res.body.failures.map((failure) => failure.code);

beforeAll(async () => {
  await require("../fixtures/adminCleanup").assertAuditCleanupAvailable();
  fixtures = await createAuthFixtures(runId, { extraAccounts: [{ key: "safetyOfficer", role: "SAFETY_OFFICER" }] });
  annexVenueId = check(
    await supabase
      .from("venue")
      .insert({ name: `spm32-${runId} Annex`, address: `spm32-${runId} 2 Test Road`, max_capacity: 500 })
      .select("venue_id")
      .single(),
    "annex venue"
  ).venue_id;
  recordFixtureIds(runId, "venueIds", [annexVenueId]);
});

afterAll(async () => {
  if (fixtures) await cleanupLifecycleRows(runId, [...Object.values(fixtures.events), ...createdEventIds]);
  await cleanupAuthFixtures(runId);
});

describe("SPM-173 readiness and submit for safety review", () => {
  test("[SPM-173-TC-12] a ready event enters SAFETY_REVIEW with an open round, and Safety Officers are notified", async () => {
    const event = await readyEvent();
    const readiness = await call("get", `/api/events/${event.event_id}/readiness`, "coordinator");
    expect(readiness.status).toBe(200);
    expect(readiness.body).toMatchObject({ ready: true, failures: [] });

    const res = await call("post", `/api/events/${event.event_id}/submit-for-safety-review`, "coordinator", { version: event.version });
    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("SAFETY_REVIEW");

    const rounds = check(await supabase.from("safety_reviews").select("status,round_number,arrangement_version").eq("event_id", event.event_id), "rounds");
    expect(rounds).toEqual([{ status: "OPEN", round_number: 1, arrangement_version: event.arrangement_version }]);
    const notices = check(
      await supabase.from("notification").select("title,notification_recipient(recipient_id)").eq("event_id", event.event_id),
      "notifications"
    );
    const recipients = notices.find((notice) => notice.title === "Event awaiting safety review").notification_recipient.map((r) => r.recipient_id);
    expect(recipients).toContain(userId("safetyOfficer"));
  });

  test("[SPM-173-TC-13] an event with no technical needs can be submitted", async () => {
    const event = await lifecycleEvent();
    await addBooking(event);
    check(await addTechnicalRequest(event, "NOT_REQUIRED"), "technical request");
    const res = await call("post", `/api/events/${event.event_id}/submit-for-safety-review`, "coordinator", { version: event.version });
    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("SAFETY_REVIEW");
  });

  const failing = [
    ["no booking", "NO_ACTIVE_BOOKING", async () => lifecycleEvent()],
    ["a PENDING booking", "BOOKING_NOT_APPROVED", async () => {
      const event = await lifecycleEvent();
      await addBooking(event, { status: "PENDING" });
      return event;
    }],
    ["no primary venue", "NO_PRIMARY_VENUE", async () => {
      const event = await lifecycleEvent();
      await addBooking(event, { isPrimary: false });
      return event;
    }],
    ["a pending technical request", "TECHNICAL_NOT_APPROVED", async () => {
      const event = await lifecycleEvent();
      await addBooking(event);
      check(await addTechnicalRequest(event, "PENDING"), "technical request");
      return event;
    }],
    ["registration above the primary venue's capacity", "REGISTRATION_EXCEEDS_PRIMARY_CAPACITY", async () =>
      readyEvent({ registration_capacity: 300 })],
    ["an open venue block", "OPEN_BLOCKING_INCIDENT", async () => {
      const event = await readyEvent();
      const { data: booking } = await supabase.from("venue_booking").select("booking_id").eq("event_id", event.event_id).single();
      // The block itself is a MongoDB venue_calendar document (Master 1.2); readiness
      // reads only the incident, so a reference ID stands in for it here.
      check(
        await supabase.from("resource_incidents").insert({
          event_id: event.event_id,
          type: "VENUE_BLOCK",
          booking_id: booking.booking_id,
          calendar_block_id: `spm32-${runId}-block`,
        }),
        "incident"
      );
      return event;
    }],
    ["an open change request", "OPEN_CHANGE_REQUEST", async () => {
      const event = await readyEvent();
      check(
        await supabase.from("event_change_request").insert({ event_id: event.event_id, requested_by: userId("organiserA"), change_details: "More seats" }),
        "change request"
      );
      return event;
    }],
  ];

  test.each(failing)("[SPM-173-TC-14] submission is blocked by %s, naming %s", async (_name, code, arrange) => {
    const event = await arrange();
    const res = await call("post", `/api/events/${event.event_id}/submit-for-safety-review`, "coordinator", { version: event.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("READINESS_BLOCKED");
    expect(readinessCodes(res)).toContain(code);
    const { data } = await supabase.from("event").select("status").eq("event_id", event.event_id).single();
    expect(data.status).toBe("PLANNING");
  });

  test("[SPM-173-TC-15] a rejected booking does not stop an otherwise ready event", async () => {
    const event = await lifecycleEvent({ expected_attendance: 40 });
    await addBooking(event);
    await addBooking(event, { isPrimary: false, venueId: annexVenueId });
    await addBooking(event, { status: "REJECTED", isPrimary: false, venueId: annexVenueId });
    const res = await call("post", `/api/events/${event.event_id}/submit-for-safety-review`, "coordinator", { version: event.version });
    expect(res.status).toBe(200);
  });
});

describe("SPM-173 confirmation", () => {
  const approvedEvent = async () => {
    const event = await readyEvent({ status: "SAFETY_REVIEW" });
    await createSafetyRound(event, { submittedBy: userId("coordinator"), decidedBy: userId("safetyOfficer") });
    return event;
  };

  test("[SPM-173-TC-16] an approved, ready event is confirmed with a snapshot and notifications", async () => {
    const event = await approvedEvent();
    const res = await call("post", `/api/events/${event.event_id}/confirm`, "coordinator", { version: event.version }, {
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("CONFIRMED");

    const { data: row } = await supabase.from("event").select("previously_confirmed").eq("event_id", event.event_id).single();
    expect(row.previously_confirmed).toBe(true);
    const snapshots = check(await supabase.from("event_confirmation_snapshots").select("snapshot").eq("event_id", event.event_id), "snapshots");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].snapshot.primary_venue).toMatchObject({ venue_id: fixtures.venue.venueId });

    const notices = check(
      await supabase.from("notification").select("title,notification_recipient(recipient_id)").eq("event_id", event.event_id),
      "notifications"
    );
    const recipients = notices.flatMap((notice) => notice.notification_recipient.map((r) => r.recipient_id));
    expect(recipients).toEqual(expect.arrayContaining([userId("organiserA"), userId("venueStaff"), userId("techSupport")]));
  });

  test("[SPM-173-TC-05] a failed notification leaves the event, snapshot and history unchanged", async () => {
    const event = await approvedEvent();
    await withPrivilegedDb(async (client) => {
      await client.query("BEGIN");
      try {
        // Created and dropped inside this rolled-back transaction only.
        await client.query(`CREATE FUNCTION public.spm173_fail_${runId}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END; $$`);
        await client.query(`CREATE TRIGGER spm173_fail_notification BEFORE INSERT ON public.notification FOR EACH ROW EXECUTE FUNCTION public.spm173_fail_${runId}()`);
        await client.query("SAVEPOINT attempt");
        await expect(
          client.query("SELECT public.confirm_event($1, $2, $3, NULL, NULL)", [event.event_id, userId("coordinator"), event.version])
        ).rejects.toThrow("forced failure");
        await client.query("ROLLBACK TO SAVEPOINT attempt");
        const state = await client.query(
          `SELECT e.status,
                  (SELECT count(*) FROM public.event_confirmation_snapshots s WHERE s.event_id = e.event_id) AS snapshots,
                  (SELECT count(*) FROM public.activity_log a WHERE a.entity_name = 'event' AND a.entity_id = e.event_id) AS history
             FROM public.event e WHERE e.event_id = $1`,
          [event.event_id]
        );
        expect(state.rows[0]).toEqual({ status: "SAFETY_REVIEW", snapshots: "0", history: "0" });
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  test("[SPM-173-TC-07] confirm racing an arrangement change: one wins, the other gets 409", async () => {
    const event = await approvedEvent();
    await withPrivilegedDb(async (client) => {
      await client.query("BEGIN");
      // Stands in for a venue block (SPM-195) holding the event lock and raising the arrangement version.
      await client.query("SELECT 1 FROM public.event WHERE event_id = $1 FOR UPDATE", [event.event_id]);
      const confirming = call("post", `/api/events/${event.event_id}/confirm`, "coordinator", { version: event.version });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await client.query("UPDATE public.event SET arrangement_version = arrangement_version + 1 WHERE event_id = $1", [event.event_id]);
      await client.query("COMMIT");
      const res = await confirming;
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("EVENT_VERSION_CONFLICT");
    });
    const { data } = await supabase.from("event").select("status").eq("event_id", event.event_id).single();
    expect(data.status).toBe("SAFETY_REVIEW");
  });
});
