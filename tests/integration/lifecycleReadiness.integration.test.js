process.env.ENABLE_COORDINATOR_WORKFLOWS = "true";
// SPM-173 readiness, submit for safety review and confirmation (AC8-AC10) on the
// live tables (supabase/migrations/20261020112025_spm173_interim_readiness.sql).
// Needs TEST_DATABASE_URL. The Master resource table version of this suite waits
// in supabase/drafts/tests with its draft migrations.
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
let annexRoomId;
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

// Every event gets its own day, so its bookings never overlap another event's
// at the shared fixture venue (BOOKING_CONFLICT) unless a test means them to.
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

const addBooking = async (event, { status = "APPROVED", roomId = fixtures.venue.roomId, attendance = null } = {}) => {
  const booking = check(
    await supabase
      .from("venue_booking")
      .insert({
        event_id: event.event_id,
        room_id: roomId,
        requested_by: userId("coordinator"),
        reviewed_by: status === "APPROVED" ? userId("venueStaff") : null,
        start_datetime: event.start_datetime,
        end_datetime: event.end_datetime,
        status,
        expected_attendance: attendance,
      })
      .select("booking_id")
      .single(),
    "booking"
  );
  recordFixtureIds(runId, "bookingIds", [booking.booking_id]);
  return booking;
};

// A technical need (the organiser's equipment requirement) and, optionally, the
// equipment request that answers it.
const addTechnicalNeed = async (event, requestStatus) => {
  check(
    await supabase.from("event_equipment_requirement").insert({ event_id: event.event_id, equipment_id: fixtures.equipmentId, quantity_requested: 1 }),
    "equipment requirement"
  );
  if (!requestStatus) return;
  check(
    await supabase.from("equipment_request").insert({
      event_id: event.event_id,
      equipment_id: fixtures.equipmentId,
      requested_by: userId("coordinator"),
      reviewed_by: requestStatus === "PENDING" ? null : userId("techSupport"),
      quantity_requested: 1,
      start_datetime: event.start_datetime,
      end_datetime: event.end_datetime,
      status: requestStatus,
    }),
    "equipment request"
  );
};

// An event in PLANNING that passes every readiness condition.
const readyEvent = async (overrides = {}) => {
  const event = await lifecycleEvent({ is_registration_enabled: true, registration_capacity: 150, ...overrides });
  await addBooking(event);
  await addTechnicalNeed(event, "APPROVED");
  return event;
};

const readinessCodes = (res) => res.body.failures.map((failure) => failure.code);

beforeAll(async () => {
  await require("../fixtures/adminCleanup").assertAuditCleanupAvailable();
  fixtures = await createAuthFixtures(runId, { extraAccounts: [{ key: "safetyOfficer", role: "SAFETY_OFFICER" }] });
  const annexVenueId = check(
    await supabase
      .from("venue")
      .insert({ name: `spm32-${runId} Annex`, address: `spm32-${runId} 2 Test Road`, max_capacity: 500 })
      .select("venue_id")
      .single(),
    "annex venue"
  ).venue_id;
  recordFixtureIds(runId, "venueIds", [annexVenueId]);
  annexRoomId = check(
    await supabase.from("room").insert({ venue_id: annexVenueId, layout_type: "THEATRE", capacity: 500 }).select("room_id").single(),
    "annex room"
  ).room_id;
  recordFixtureIds(runId, "roomIds", [annexRoomId]);
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
    ["a booking above the venue's capacity", "BOOKING_OVER_CAPACITY", async () => {
      const event = await lifecycleEvent();
      await addBooking(event, { attendance: 250 });
      return event;
    }],
    ["another event's booking at the same venue and time", "BOOKING_CONFLICT", async () => {
      const event = await lifecycleEvent();
      await addBooking(event);
      // Unassigned, so the coordinator schedule guard does not refuse the overlap.
      const other = await lifecycleEvent({ status: "SUBMITTED", coordinator_id: null, start_datetime: event.start_datetime, end_datetime: event.end_datetime });
      await addBooking(other, { status: "PENDING" });
      return event;
    }],
    ["two active bookings and no primary flag yet", "NO_PRIMARY_VENUE", async () => {
      const event = await lifecycleEvent();
      await addBooking(event);
      await addBooking(event, { roomId: annexRoomId });
      return event;
    }],
    ["a pending equipment request", "TECHNICAL_NOT_APPROVED", async () => {
      const event = await lifecycleEvent();
      await addBooking(event);
      await addTechnicalNeed(event, "PENDING");
      return event;
    }],
    ["equipment required but never requested", "TECHNICAL_NOT_APPROVED", async () => {
      const event = await lifecycleEvent();
      await addBooking(event);
      await addTechnicalNeed(event, null);
      return event;
    }],
    ["registration above the primary venue's capacity", "REGISTRATION_EXCEEDS_PRIMARY_CAPACITY", async () =>
      readyEvent({ registration_capacity: 300 })],
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
    await addBooking(event, { status: "REJECTED", roomId: annexRoomId });
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

  // Attendee lifecycle rule (31 October 2026): confirmation publishes the event,
  // and it stays attendee-facing and registration-capable in PREPARATION.
  test("[ATTENDEE-LIFECYCLE] the real confirmation publishes the event, which stays discoverable and registrable in preparation", async () => {
    const attendeeGet = (path) => call("get", path, "attendee");
    const listed = async (eventId) => {
      let cursor = null;
      do {
        const res = await attendeeGet(`/api/events/discovery?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
        if (res.status !== 200) throw new Error(`Discovery list failed with ${res.status}`);
        const found = res.body.events.find((item) => item.eventId === eventId);
        if (found) return found;
        cursor = res.body.nextCursor;
      } while (cursor);
      return null;
    };

    const event = await approvedEvent();
    const startsAt = new Date(event.start_datetime).getTime();
    check(
      await supabase.from("event").update({
        registration_open_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        registration_close_at: new Date(startsAt - 60 * 60 * 1000).toISOString(),
      }).eq("event_id", event.event_id).select("event_id"),
      "registration window"
    );
    const { data: before } = await supabase.from("event").select("is_published,version").eq("event_id", event.event_id).single();
    expect(before.is_published).toBe(false);
    expect(await listed(event.event_id)).toBeNull();
    expect((await attendeeGet(`/api/events/discovery/${event.event_id}`)).status).toBe(404);

    const confirmed = await call("post", `/api/events/${event.event_id}/confirm`, "coordinator", { version: before.version });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.event.status).toBe("CONFIRMED");

    const { data: row } = await supabase.from("event").select("is_published").eq("event_id", event.event_id).single();
    expect(row.is_published).toBe(true);
    const snapshots = check(await supabase.from("event_confirmation_snapshots").select("snapshot").eq("event_id", event.event_id), "snapshots");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].snapshot.is_published).toBe(true);
    expect(await listed(event.event_id)).toMatchObject({ eventId: event.event_id, registrationAvailability: "OPEN" });

    const preparing = await call("post", `/api/events/${event.event_id}/start-preparation`, "coordinator", { version: confirmed.body.event.version });
    expect(preparing.status).toBe(200);
    expect(preparing.body.event.status).toBe("PREPARATION");

    expect(await listed(event.event_id)).toMatchObject({ eventId: event.event_id, registrationAvailability: "OPEN" });
    const detail = await attendeeGet(`/api/events/discovery/${event.event_id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.event).toMatchObject({ eventId: event.event_id, registrationAvailability: "OPEN" });

    const registered = await call("post", `/api/registrations/mine/${event.event_id}`, "attendee", {
      dietaryRestrictions: null,
      accessibilityRequirements: null,
    });
    if (registered.body.registration) recordFixtureIds(runId, "registrationIds", [registered.body.registration.registrationId]);
    expect(registered.status).toBe(201);
    expect(registered.body.registration.status).toBe("REGISTERED");
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
