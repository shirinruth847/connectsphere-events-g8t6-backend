process.env.ENABLE_COORDINATOR_WORKFLOWS = "true";
// SPM-173 against real Supabase Auth, PostgREST and the lifecycle functions.
// Needs migrations 20261019075257 to 20261019075510 and TEST_DATABASE_URL.
// State-machine cases run inside rolled-back transactions on the privileged
// connection; everything else is namespaced fixture data removed after the run.
// Cases that need readiness to pass (a successful submit for safety review or
// confirm) are in lifecycleReadiness.integration.test.js.
const crypto = require("crypto");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const {
  inRolledBackTransaction,
  withPrivilegedDb,
  createLifecycleEvent,
  createSafetyRound,
  cleanupLifecycleRows,
} = require("../fixtures/lifecycleFixtures");

jest.setTimeout(180000);

const runId = newRunId();
const createdEventIds = [];
let fixtures;
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

const userId = (key) => fixtures.accounts[key].userId;

const lifecycleEvent = async (overrides) => {
  const event = await createLifecycleEvent(fixtures, overrides);
  createdEventIds.push(event.event_id);
  return event;
};

const eventStatus = async (eventId) =>
  (await supabase.from("event").select("status,version").eq("event_id", eventId).single()).data;

beforeAll(async () => {
  await require("../fixtures/adminCleanup").assertAuditCleanupAvailable();
  fixtures = await createAuthFixtures(runId, { extraAccounts: [{ key: "safetyOfficer", role: "SAFETY_OFFICER" }] });
});

afterAll(async () => {
  if (fixtures) await cleanupLifecycleRows(runId, [...Object.values(fixtures.events), ...createdEventIds]);
  await cleanupAuthFixtures(runId);
});

// ---------- the transition table (TC-01, TC-02) ----------

// Every action in Master 5.2, with a state it is allowed from, the actor who may
// run it and the state it lands in. ANY-actor and system actions pass null.
const ACTIONS = [
  ["submit", "DRAFT", "organiserA", "SUBMITTED"],
  ["withdraw", "SUBMITTED", "organiserA", "CANCELLED"],
  ["assign", "SUBMITTED", "coordinatorLead", "UNDER_REVIEW"],
  ["request_clarification", "UNDER_REVIEW", "coordinator", "AWAITING_CLARIFICATION"],
  ["resubmit", "AWAITING_CLARIFICATION", "organiserA", "UNDER_REVIEW"],
  ["complete_clarification", "AWAITING_CLARIFICATION", "coordinator", "UNDER_REVIEW"],
  ["accept_feasibility", "UNDER_REVIEW", "coordinator", "PLANNING"],
  ["submit_for_safety_review", "PLANNING", "coordinator", "SAFETY_REVIEW"],
  ["safety_changes_requested", "SAFETY_REVIEW", "safetyOfficer", "PLANNING"],
  ["safety_rejected", "SAFETY_REVIEW", "safetyOfficer", "PLANNING"],
  ["safety_superseded", "SAFETY_REVIEW", null, "PLANNING"],
  ["confirm", "SAFETY_REVIEW", "coordinator", "CONFIRMED"],
  ["start_preparation", "CONFIRMED", "coordinator", "PREPARATION"],
  ["complete", "PREPARATION", "coordinator", "COMPLETED"],
  ["reject", "PLANNING", "coordinator", "REJECTED"],
  ["accept_change", "CONFIRMED", "coordinator", "PLANNING"],
  ["cancel", "PREPARATION", "coordinator", "CANCELLED"],
  ["venue_replacement", "CONFIRMED", "coordinator", "PLANNING"],
];

const STATES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "AWAITING_CLARIFICATION", "PLANNING", "SAFETY_REVIEW", "CONFIRMED", "PREPARATION", "COMPLETED", "REJECTED", "CANCELLED"];
const ALLOWED_FROM = {
  submit: ["DRAFT"],
  withdraw: ["SUBMITTED"],
  assign: ["SUBMITTED"],
  request_clarification: ["UNDER_REVIEW"],
  resubmit: ["AWAITING_CLARIFICATION"],
  complete_clarification: ["AWAITING_CLARIFICATION"],
  accept_feasibility: ["UNDER_REVIEW"],
  submit_for_safety_review: ["PLANNING"],
  safety_changes_requested: ["SAFETY_REVIEW"],
  safety_rejected: ["SAFETY_REVIEW"],
  safety_superseded: ["SAFETY_REVIEW"],
  confirm: ["SAFETY_REVIEW"],
  start_preparation: ["CONFIRMED"],
  complete: ["CONFIRMED", "PREPARATION"],
  reject: ["UNDER_REVIEW", "AWAITING_CLARIFICATION", "PLANNING", "SAFETY_REVIEW"],
  accept_change: ["PLANNING", "SAFETY_REVIEW", "CONFIRMED", "PREPARATION"],
  cancel: ["UNDER_REVIEW", "AWAITING_CLARIFICATION", "PLANNING", "SAFETY_REVIEW", "CONFIRMED", "PREPARATION"],
  venue_replacement: ["SAFETY_REVIEW", "CONFIRMED", "PREPARATION"],
};

// Inserts an event inside the rolled-back transaction, owned by organiserA with
// the fixture coordinator, plus an open round claimed by the Safety Officer, so
// that only the state decides whether an action is allowed. Its day is one no
// committed fixture event uses, so the coordinator's schedule never overlaps.
const insertEventInState = async (client, status, { coordinator = true } = {}) => {
  const { rows } = await client.query(
    `INSERT INTO public.event (title, purpose, description, organiser_id, coordinator_id, status, expected_attendance,
       start_datetime, end_datetime, preferred_layout_type)
     VALUES ($1, 'p', 'd', $2, $3, $4, 50, '2028-01-01T01:00:00Z', '2028-01-01T03:00:00Z', 'THEATRE')
     RETURNING event_id, version`,
    [`spm32-${runId} state ${status}`, userId("organiserA"), coordinator ? userId("coordinator") : null, status]
  );
  await client.query(
    `INSERT INTO public.safety_reviews (event_id, round_number, arrangement_version, status, submitted_by, claimed_by, claimed_at)
     VALUES ($1, 1, 1, 'OPEN', $2, $3, now())`,
    [rows[0].event_id, userId("coordinator"), userId("safetyOfficer")]
  );
  return rows[0];
};

const transition = (client, eventId, action, actorKey, version = null) =>
  client.query("SELECT (public._transition_event($1, $2, $3, $4, 'test')).status AS status", [
    eventId,
    action,
    actorKey ? userId(actorKey) : null,
    version,
  ]);

describe("SPM-173 transition table", () => {
  test.each(ACTIONS)(
    "[SPM-173-TC-01] %s from %s by %s lands in %s with one history entry",
    async (action, from, actorKey, to) => {
      await inRolledBackTransaction(async (client) => {
        const needsNoCoordinator = ["DRAFT", "SUBMITTED"].includes(from);
        const event = await insertEventInState(client, from, { coordinator: !needsNoCoordinator });
        if (action === "assign") {
          await client.query("UPDATE public.event SET coordinator_id = $1 WHERE event_id = $2", [userId("coordinator"), event.event_id]);
        }
        const { rows } = await transition(client, event.event_id, action, actorKey);
        expect(rows[0].status).toBe(to);
        const history = await client.query(
          "SELECT action, actor_role, changes FROM public.activity_log WHERE entity_name = 'event' AND entity_id = $1",
          [event.event_id]
        );
        expect(history.rows).toHaveLength(1);
        expect(history.rows[0].changes).toEqual({ status: { before: from, after: to } });
        expect(history.rows[0].actor_role).toBe(actorKey ? fixtures.accounts[actorKey].role : "SYSTEM");
      });
    }
  );

  const refused = ACTIONS.flatMap(([action, , actorKey]) =>
    STATES.filter((state) => !ALLOWED_FROM[action].includes(state)).map((state) => [action, state, actorKey])
  );

  test.each(refused)("[SPM-173-TC-02] %s from %s is refused naming the state", async (action, state, actorKey) => {
    await inRolledBackTransaction(async (client) => {
      const event = await insertEventInState(client, state);
      await client.query("SAVEPOINT attempt");
      await expect(transition(client, event.event_id, action, actorKey)).rejects.toMatchObject({
        message: "TRANSITION_NOT_ALLOWED",
        detail: state,
      });
      await client.query("ROLLBACK TO SAVEPOINT attempt");
      const after = await client.query("SELECT status FROM public.event WHERE event_id = $1", [event.event_id]);
      expect(after.rows[0].status).toBe(state);
    });
  });

  test("[SPM-173-TC-02] reject is refused for a previously confirmed event", async () => {
    await inRolledBackTransaction(async (client) => {
      const event = await insertEventInState(client, "PLANNING");
      await client.query("UPDATE public.event SET previously_confirmed = true WHERE event_id = $1", [event.event_id]);
      await expect(transition(client, event.event_id, "reject", "coordinator")).rejects.toMatchObject({ message: "TRANSITION_NOT_ALLOWED" });
    });
  });

  test("[SPM-173-AC3] a Lead or a Safety Officer cannot run a coordinator decision", async () => {
    await inRolledBackTransaction(async (client) => {
      const event = await insertEventInState(client, "UNDER_REVIEW");
      for (const actorKey of ["coordinatorLead", "safetyOfficer"]) {
        await client.query("SAVEPOINT attempt");
        await expect(transition(client, event.event_id, "accept_feasibility", actorKey)).rejects.toMatchObject({ message: "TRANSITION_NOT_ALLOWED" });
        await client.query("ROLLBACK TO SAVEPOINT attempt");
      }
    });
  });

  test("[SPM-173-AC5] a stale version is refused with the current state", async () => {
    await inRolledBackTransaction(async (client) => {
      const event = await insertEventInState(client, "CONFIRMED");
      await expect(transition(client, event.event_id, "start_preparation", "coordinator", event.version + 1)).rejects.toMatchObject({
        message: "EVENT_VERSION_CONFLICT",
        detail: "CONFIRMED",
      });
    });
  });

  test("[SPM-173-TC-06] DRAFT to COMPLETED records one entry per transition, the last by System", async () => {
    await inRolledBackTransaction(async (client) => {
      const event = await insertEventInState(client, "DRAFT", { coordinator: false });
      await transition(client, event.event_id, "submit", "organiserA");
      await client.query("UPDATE public.event SET coordinator_id = $1 WHERE event_id = $2", [userId("coordinator"), event.event_id]);
      for (const [action, actorKey] of [
        ["assign", "coordinatorLead"],
        ["accept_feasibility", "coordinator"],
        ["submit_for_safety_review", "coordinator"],
        ["confirm", "coordinator"],
        ["start_preparation", "coordinator"],
        ["complete", null],
      ]) {
        await transition(client, event.event_id, action, actorKey);
      }
      const { rows } = await client.query(
        "SELECT action, actor_role FROM public.activity_log WHERE entity_name = 'event' AND entity_id = $1 ORDER BY log_id",
        [event.event_id]
      );
      expect(rows.map((row) => row.action)).toEqual([
        "EVENT_SUBMITTED",
        "COORDINATOR_ASSIGNED",
        "FEASIBILITY_ACCEPTED",
        "SAFETY_REVIEW_SUBMITTED",
        "EVENT_CONFIRMED",
        "PREPARATION_STARTED",
        "EVENT_COMPLETED",
      ]);
      expect(rows[rows.length - 1].actor_role).toBe("SYSTEM");
    });
  });
});

// ---------- API behaviour ----------

describe("SPM-173 coordinator actions through the API", () => {
  test("[SPM-173-TC-03] a direct status edit is refused for the coordinator", async () => {
    const event = await lifecycleEvent({ status: "PLANNING" });
    const res = await call("put", `/api/events/${event.event_id}`, "coordinator", { version: event.version, status: "CONFIRMED" }, {
      "Idempotency-Key": crypto.randomUUID(),
    });
    expect(res.status).toBe(403);
    expect((await eventStatus(event.event_id)).status).toBe("PLANNING");
  });

  test("[SPM-173-TC-04] a Lead and a Safety Officer cannot confirm", async () => {
    const event = await lifecycleEvent({ status: "SAFETY_REVIEW" });
    for (const key of ["coordinatorLead", "safetyOfficer"]) {
      const res = await call("post", `/api/events/${event.event_id}/confirm`, key, { version: event.version });
      expect(res.status).toBe(403);
    }
    expect((await eventStatus(event.event_id)).status).toBe("SAFETY_REVIEW");
  });

  test("[SPM-173-AC3] another coordinator's event is not found", async () => {
    const event = await lifecycleEvent({ status: "CONFIRMED", coordinator_id: userId("coordinatorTwo") });
    const res = await call("post", `/api/events/${event.event_id}/start-preparation`, "coordinator", { version: event.version });
    expect(res.status).toBe(404);
  });

  test("[SPM-173-TC-08][SPM-173-TC-19] start preparation once, even when retried with the same key", async () => {
    const event = await lifecycleEvent({ status: "CONFIRMED" });
    const key = crypto.randomUUID();
    const first = await call("post", `/api/events/${event.event_id}/start-preparation`, "coordinator", { version: event.version }, { "Idempotency-Key": key });
    const replay = await call("post", `/api/events/${event.event_id}/start-preparation`, "coordinator", { version: event.version }, { "Idempotency-Key": key });

    expect(first.status).toBe(200);
    expect(first.body.event.status).toBe("PREPARATION");
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    const history = await supabase.from("activity_log").select("action").eq("entity_name", "event").eq("entity_id", event.event_id);
    expect(history.data.map((row) => row.action)).toEqual(["PREPARATION_STARTED"]);
  });

  test("[SPM-173-TC-17] confirm is refused while the round is still open", async () => {
    const event = await lifecycleEvent({ status: "SAFETY_REVIEW" });
    await createSafetyRound(event, { status: "OPEN", submittedBy: userId("coordinator") });
    const res = await call("post", `/api/events/${event.event_id}/confirm`, "coordinator", { version: event.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SAFETY_APPROVAL_REQUIRED");
    expect((await eventStatus(event.event_id)).status).toBe("SAFETY_REVIEW");
  });

  test("[SPM-173-TC-18] an approval for an older arrangement version does not count", async () => {
    const event = await lifecycleEvent({ status: "SAFETY_REVIEW", arrangement_version: 6 });
    await createSafetyRound(event, { submittedBy: userId("coordinator"), decidedBy: userId("safetyOfficer"), arrangementVersion: 5 });
    const res = await call("post", `/api/events/${event.event_id}/confirm`, "coordinator", { version: event.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SAFETY_APPROVAL_REQUIRED");
  });

  test("[SPM-173-AC5] the second of two actions on the same version gets 409 with the current state", async () => {
    const event = await lifecycleEvent({ status: "CONFIRMED" });
    const [first, second] = await Promise.all([
      call("post", `/api/events/${event.event_id}/start-preparation`, "coordinator", { version: event.version }),
      call("post", `/api/events/${event.event_id}/start-preparation`, "coordinator", { version: event.version }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.code).toBe("EVENT_VERSION_CONFLICT");
    expect(loser.body.event.status).toBe("PREPARATION");
  });

  test("[SPM-173-TC-24] manual completion before the end is refused", async () => {
    const event = await lifecycleEvent({ status: "PREPARATION" });
    const res = await call("post", `/api/events/${event.event_id}/complete`, "coordinator", { version: event.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_NOT_ENDED");
  });

  test("[SPM-173-AC12] manual completion after the end", async () => {
    const event = await lifecycleEvent({
      status: "PREPARATION",
      start_datetime: "2026-01-01T01:00:00Z",
      end_datetime: "2026-01-01T03:00:00Z",
    });
    const res = await call("post", `/api/events/${event.event_id}/complete`, "coordinator", { version: event.version });
    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("COMPLETED");
  });

  test("[SPM-173-TC-11] submission notifies the owner and every Lead", async () => {
    const res = await call(
      "post",
      "/api/events",
      "organiserA",
      {
        title: `spm32-${runId} notify`,
        purpose: "Notification check",
        description: "Notification check",
        startDatetime: "2027-06-01T01:00:00Z",
        endDatetime: "2027-06-01T03:00:00Z",
        expectedAttendance: 20,
        preferredLayoutType: "THEATRE",
      },
      { "Idempotency-Key": crypto.randomUUID() }
    );
    expect(res.status).toBe(201);
    const eventId = res.body.event.eventId;
    createdEventIds.push(eventId);
    recordFixtureIds(runId, "eventIds", [eventId]);

    // One receipt shared by the owner and every active Lead (SPM-36 shape).
    const { data } = await supabase.from("notification").select("title,notification_recipient(recipient_id)").eq("event_id", eventId);
    expect(data.map(({ title }) => title)).toEqual(["Event request received"]);
    const { data: leads } = await supabase.from("user").select("user_id").eq("role", "COORDINATOR_LEAD").eq("is_active", true);
    expect(data[0].notification_recipient.map(({ recipient_id }) => recipient_id).sort((a, b) => a - b))
      .toEqual([userId("organiserA"), ...leads.map(({ user_id }) => user_id)].sort((a, b) => a - b));
  });

  test("[SPM-173-TC-10] the organiser filters by label", async () => {
    const planning = await lifecycleEvent({ status: "PLANNING" });
    const review = await lifecycleEvent({ status: "SAFETY_REVIEW" });
    const res = await call("get", "/api/events/mine?label=Approved%20%26%20Planning&limit=50", "organiserA");
    expect(res.status).toBe(200);
    const ids = res.body.events.map((event) => event.eventId);
    expect(ids).toEqual(expect.arrayContaining([planning.event_id, review.event_id]));
    expect(res.body.events.every((event) => event.statusLabel === "Approved & Planning")).toBe(true);
  });
});

// ---------- completion job (TC-21 to TC-23) ----------

describe("SPM-173 completion job", () => {
  // Database time cannot be set, so the boundary is an end two seconds ahead.
  // Each run is rolled back, so other events on the shared project are untouched.
  test("[SPM-173-TC-21][SPM-173-TC-22][SPM-173-TC-23] completes ended CONFIRMED and PREPARATION events only", async () => {
    const endsSoon = await withPrivilegedDb(async (client) => {
      const { rows } = await client.query("SELECT now() + interval '2 seconds' AS end_at, now() - interval '1 hour' AS start_at");
      return rows[0];
    });
    const preparing = await lifecycleEvent({ status: "PREPARATION", start_datetime: endsSoon.start_at, end_datetime: endsSoon.end_at });
    const confirmed = await lifecycleEvent({ status: "CONFIRMED", start_datetime: "2026-01-02T01:00:00Z", end_datetime: "2026-01-02T03:00:00Z" });
    const planning = await lifecycleEvent({ status: "PLANNING", start_datetime: "2026-01-03T01:00:00Z", end_datetime: "2026-01-03T03:00:00Z" });

    const statusesAfterRun = () =>
      inRolledBackTransaction(async (client) => {
        await client.query("SELECT public.complete_due_events(500)");
        const { rows } = await client.query("SELECT event_id, status FROM public.event WHERE event_id = ANY($1::integer[])", [
          [preparing.event_id, confirmed.event_id, planning.event_id],
        ]);
        return Object.fromEntries(rows.map((row) => [row.event_id, row.status]));
      });

    const before = await statusesAfterRun();
    expect(before[preparing.event_id]).toBe("PREPARATION");
    expect(before[confirmed.event_id]).toBe("COMPLETED");
    expect(before[planning.event_id]).toBe("PLANNING");

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const after = await statusesAfterRun();
    expect(after[preparing.event_id]).toBe("COMPLETED");
    expect(after[planning.event_id]).toBe("PLANNING");
  });
});
