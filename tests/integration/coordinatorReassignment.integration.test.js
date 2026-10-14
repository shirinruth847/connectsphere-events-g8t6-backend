// SPM-180 acceptance test against real Supabase Auth, PostgREST and RPC.
// Auth fixtures and all event data are namespaced and removed after the run.
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures } = require("../fixtures/authFixtures");

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
  fixtures = await createAuthFixtures(runId);
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("SPM-180 complete reassignment flow", () => {
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
