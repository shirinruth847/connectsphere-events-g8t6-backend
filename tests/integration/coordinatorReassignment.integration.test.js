process.env.ENABLE_COORDINATOR_WORKFLOWS = "true";
// SPM-180 acceptance test against real Supabase Auth, PostgREST and RPC.
// Auth fixtures and all event data are namespaced and removed after the run.
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const runId = newRunId();
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

const call = async (method, path, key, body) => {
  const session = await signIn(key);
  const req = request(app)[method](path).set("Authorization", `Bearer ${session.access_token}`);
  if (method === "patch" && body?.expectedCoordinatorId !== undefined) {
    req.set("Idempotency-Key", require("node:crypto").randomUUID());
  }
  return body === undefined ? req : req.send(body);
};

const rows = async (query, step) => {
  const { data, error } = await query;
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};

const eventRow = (eventId) => rows(
  supabase.from("event").select("status,coordinator_id").eq("event_id", eventId).single(),
  "event lookup",
);

beforeAll(async () => {
  await require("../fixtures/adminCleanup").assertAuditCleanupAvailable();
  fixtures = await createAuthFixtures(runId, { extraAccounts: [{ key: "otherLead", role: "COORDINATOR_LEAD" }] });
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("SPM-180 complete reassignment flow", () => {
  test("[SPM-174] the database guard serializes direct writes across two real connections", async () => {
    const { withCleanupConnection } = require("../fixtures/adminCleanup");
    await withCleanupConnection(async first => withCleanupConnection(async second => {
      const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const insert = `INSERT INTO public.event
        (title,purpose,description,organiser_id,coordinator_id,status,start_datetime,end_datetime,expected_attendance,preferred_layout_type)
        VALUES ($1,'Synthetic direct-write race','Removed after this run',$2,$3,'SUBMITTED','2033-01-10T02:00:00Z','2033-01-10T04:00:00Z',10,'THEATRE') RETURNING event_id`;
      let pending;
      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        await first.query("SET LOCAL ROLE service_role");
        await second.query("SET LOCAL ROLE service_role");
        const created = await first.query(insert, [`spm32-${runId} guard A`, fixtures.accounts.organiserA.userId, fixtures.accounts.coordinatorThree.userId]);
        recordFixtureIds(runId, "eventIds", [created.rows[0].event_id]);
        // Writes above use runtime privileges; only lock observation uses the
        // privileged test connection. No query text or unrelated rows are read.
        await first.query("RESET ROLE");
        pending = second.query(insert, [`spm32-${runId} guard B`, fixtures.accounts.organiserA.userId, fixtures.accounts.coordinatorThree.userId])
          .then(result => ({ result }), error => ({ error }));
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          await first.query("SELECT pg_stat_clear_snapshot()");
          const state = await first.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [secondPid]);
          if (state.rows[0]?.wait_event_type === "Lock") { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        await first.query("COMMIT");
        const outcome = await pending;
        if (outcome.result) recordFixtureIds(runId, "eventIds", outcome.result.rows.map(row => row.event_id));
        expect(blocked).toBe(true);
        expect(outcome.error?.code).toBe("23P01");
        expect(outcome.error?.message).toBe("COORDINATOR_CONFLICT");
      } finally {
        await first.query("ROLLBACK");
        if (pending) await pending;
        await second.query("ROLLBACK");
      }
    }));
  });

  test("[SPM-174] another Lead cannot read or reassign a supervised event", async () => {
    const eventId = fixtures.events.reassignable;
    const list = await call("get", "/api/events/assignments", "otherLead");
    expect(list.status).toBe(200);
    expect(list.body.assignments.some(event => event.eventId === eventId)).toBe(false);
    const denied = await call("patch", `/api/events/${eventId}/coordinator`, "otherLead", {
      coordinatorId: fixtures.accounts.coordinatorThree.userId,
      expectedCoordinatorId: fixtures.accounts.coordinator.userId,
    });
    expect(denied.status).toBe(404);
    expect((await eventRow(eventId)).coordinator_id).toBe(fixtures.accounts.coordinator.userId);
  });

  test("[SPM-174] concurrent overlapping assignments commit exactly one complete result", async () => {
    const events = await rows(supabase.from("event").insert(["A", "B"].map(label => ({
      title: `spm32-${runId} concurrent ${label}`,
      purpose: "Synthetic assignment race",
      description: "Removed after this run",
      organiser_id: fixtures.accounts.organiserA.userId,
      organisation_id: fixtures.organisations.A,
      status: "SUBMITTED",
      start_datetime: "2032-01-10T02:00:00Z",
      end_datetime: "2032-01-10T04:00:00Z",
      expected_attendance: 10,
      preferred_layout_type: "THEATRE",
    }))).select("event_id"), "race fixtures");
    const ids = events.map(event => event.event_id);
    recordFixtureIds(runId, "eventIds", ids);
    const results = await Promise.all(ids.map(id => call("post", `/api/events/${id}/coordinator`, "coordinatorLead", {
      coordinatorId: fixtures.accounts.coordinatorThree.userId,
    })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409).body.code).toBe("COORDINATOR_CONFLICT");
    const winner = ids[results.findIndex(result => result.status === 200)];
    const loser = ids.find(id => id !== winner);
    expect(await eventRow(winner)).toEqual({ status: "UNDER_REVIEW", coordinator_id: fixtures.accounts.coordinatorThree.userId });
    expect(await eventRow(loser)).toEqual({ status: "SUBMITTED", coordinator_id: null });
    const history = await rows(supabase.from("event_assignments").select("event_id,ended_at").in("event_id", ids), "race history");
    expect(history).toEqual([{ event_id: winner, ended_at: null }]);
    const notifications = await rows(supabase.from("notification").select("event_id").in("event_id", ids), "race notifications");
    expect(notifications).toHaveLength(2);
    expect(notifications.every(notification => notification.event_id === winner)).toBe(true);
  });

  test("[SPM-180-AC1/AC2/AC5] lead reassigns, owner and coordinators are notified, and history is preserved", async () => {
    const eventId = fixtures.events.reassignable;
    const oldCoordinatorId = fixtures.accounts.coordinator.userId;
    const newCoordinatorId = fixtures.accounts.coordinatorThree.userId;
    const leadId = fixtures.accounts.coordinatorLead.userId;

    const assignments = await call("get", "/api/events/assignments", "coordinatorLead");
    expect(assignments.status).toBe(200);
    expect(assignments.body.assignments).toContainEqual(expect.objectContaining({
      eventId,
      coordinatorId: oldCoordinatorId,
      coordinatorName: "spm32 coordinator",
    }));

    const result = await call("patch", `/api/events/${eventId}/coordinator`, "coordinatorLead", {
      coordinatorId: newCoordinatorId,
      expectedCoordinatorId: oldCoordinatorId,
    });
    expect(result.status).toBe(200);
    expect(result.body.event.coordinatorId).toBe(newCoordinatorId);
    expect(result.body.coordinator.name).toBe("spm32 coordinatorThree");
    expect(await eventRow(eventId)).toEqual({ status: "PLANNING", coordinator_id: newCoordinatorId });

    const [oldList, newList, oldDetail, newDetail] = await Promise.all([
      call("get", "/api/events/assigned", "coordinator"),
      call("get", "/api/events/assigned", "coordinatorThree"),
      call("get", `/api/events/${eventId}`, "coordinator"),
      call("get", `/api/events/${eventId}`, "coordinatorThree"),
    ]);
    expect(oldList.body.events).not.toEqual(expect.arrayContaining([expect.objectContaining({ eventId })]));
    expect(newList.body.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventId })]));
    expect(oldDetail.status).toBe(404);
    expect(newDetail.status).toBe(200);

    const history = await rows(
      supabase.from("event_assignments").select("coordinator_id,assigned_by,ended_at")
        .eq("event_id", eventId).order("assignment_id", { ascending: true }),
      "assignment history",
    );
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(expect.objectContaining({ coordinator_id: oldCoordinatorId, ended_at: expect.any(String) }));
    expect(history[1]).toEqual(expect.objectContaining({ coordinator_id: newCoordinatorId, assigned_by: leadId, ended_at: null }));

    const notifications = await rows(
      supabase.from("notification").select("title,notification_recipient(recipient_id)").eq("event_id", eventId),
      "reassignment notifications",
    );
    const recipients = notifications.flatMap(({ notification_recipient: audience }) => audience.map(({ recipient_id }) => recipient_id));
    expect(notifications.map(({ title }) => title).sort()).toEqual([
      "Event assignment ended",
      "Event coordinator changed",
      "New event coordination assignment",
    ]);
    expect(recipients.sort()).toEqual([fixtures.accounts.organiserA.userId, oldCoordinatorId, newCoordinatorId].sort());
  });

  test("[SPM-180-AC3/AC4/AC6] non-leads are denied, stale owners are rejected, and schedules block conflicts", async () => {
    const eventId = fixtures.events.reassignable;
    const oldCoordinatorId = fixtures.accounts.coordinator.userId;
    const currentCoordinatorId = fixtures.accounts.coordinatorThree.userId;
    const busyCoordinatorId = fixtures.accounts.coordinatorTwo.userId;

    const denied = await call("patch", `/api/events/${eventId}/coordinator`, "coordinator", {
      coordinatorId: oldCoordinatorId,
      expectedCoordinatorId: currentCoordinatorId,
    });
    expect(denied.status).toBe(403);
    expect(await eventRow(eventId)).toEqual({ status: "PLANNING", coordinator_id: currentCoordinatorId });

    const stale = await call("patch", `/api/events/${eventId}/coordinator`, "coordinatorLead", {
      coordinatorId: oldCoordinatorId,
      expectedCoordinatorId: oldCoordinatorId,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("ASSIGNMENT_CHANGED");

    const conflict = await call("patch", `/api/events/${eventId}/coordinator`, "coordinatorLead", {
      coordinatorId: busyCoordinatorId,
      expectedCoordinatorId: currentCoordinatorId,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("COORDINATOR_CONFLICT");
    expect(await eventRow(eventId)).toEqual({ status: "PLANNING", coordinator_id: currentCoordinatorId });
  });

  test("[SPM-180] lead workspace reads include active candidates and queue events; terminal events remain non-reassignable", async () => {
    const [availability, unassigned, terminal] = await Promise.all([
      call("get", "/api/events/coordinator-availability", "coordinatorLead"),
      call("get", "/api/events/unassigned", "coordinatorLead"),
      call("patch", `/api/events/${fixtures.events.completedAssignment}/coordinator`, "coordinatorLead", {
        coordinatorId: fixtures.accounts.coordinatorTwo.userId,
        expectedCoordinatorId: fixtures.accounts.coordinator.userId,
      }),
    ]);
    expect(availability.status).toBe(200);
    expect(availability.body.coordinators.map(({ coordinatorId }) => coordinatorId)).toEqual(expect.arrayContaining([
      fixtures.accounts.coordinator.userId,
      fixtures.accounts.coordinatorTwo.userId,
      fixtures.accounts.coordinatorThree.userId,
    ]));
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: fixtures.events.unassignedQueueItem, status: "SUBMITTED" }),
    ]));
    expect(terminal.status).toBe(404);
  });
});
