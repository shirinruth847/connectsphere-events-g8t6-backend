process.env.ENABLE_COORDINATOR_WORKFLOWS = "true";
// SPM-193 against real Supabase Auth, PostgREST and the notification
// functions: coordinator visibility, the assignment and reassignment notices,
// clarification replies, read state and retries. Needs migrations
// 20261027051734 and 20261027090100 to 20261027090300, and TEST_DATABASE_URL. Triggers that do not
// exist yet (holds, venue blocks, technical decisions) and the safety-outcome
// wording are tested in tests/database/spm193*.test.cjs.
//
// One request (E1) goes through assignment, clarification and reassignment in
// order, so the tests in the first block must run in this file's order.
// Fixtures are spm32-<run> accounts and events, removed after the run with
// their notifications.
const crypto = require("node:crypto");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");

jest.setTimeout(180000);

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

const call = async (method, path, key, body, idempotencyKey) => {
  let req = request(app)[method](path).set("Authorization", `Bearer ${(await signIn(key)).access_token}`);
  if (idempotencyKey) req = req.set("Idempotency-Key", idempotencyKey);
  return body === undefined ? req : req.send(body);
};

const userId = (key) => fixtures.accounts[key].userId;
const newKey = () => crypto.randomUUID();
const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const requestId = (eventId) => `REQ-${String(eventId).padStart(6, "0")}`;

const eventVersion = async (eventId) => {
  const { data, error } = await supabase.from("event").select("version").eq("event_id", eventId).single();
  if (error) throw error;
  return data.version;
};

const inboxFor = async (key) => {
  const res = await call("get", "/api/notifications?limit=100", key);
  expect(res.status).toBe(200);
  return res.body;
};
const noticesAbout = async (key, eventId) =>
  (await inboxFor(key)).notifications.filter((notice) => notice.event && notice.event.event_id === eventId);

const submitRequest = async (label, { start = inDays(650), end = inDays(650.1) } = {}) => {
  const res = await call("post", "/api/events", "organiserA", {
    title: `spm32-${runId} ${label}`,
    purpose: "Synthetic coordinator notification check",
    description: "Talks and networking for the SPM-193 run.",
    startDatetime: start,
    endDatetime: end,
    expectedAttendance: 80,
    preferredLayoutType: "THEATRE",
    accessibilityNeeds: [],
    isRegistrationEnabled: false,
  }, newKey());
  expect(res.status).toBe(201);
  const eventId = res.body.event.eventId;
  recordFixtureIds(runId, "eventIds", [eventId]);
  return eventId;
};

const assign = (eventId, coordinatorKey) =>
  call("post", `/api/events/${eventId}/coordinator`, "coordinatorLead", { coordinatorId: userId(coordinatorKey) });

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for the coordinator notification tests.");
  fixtures = await createAuthFixtures(runId);
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("a coordinator's event through its notifications (SPM-193)", () => {
  let eventId;
  let assignmentNotice;

  test("[SPM-193-TC-01/TC-16] the assigned coordinator receives one assignment notice, even when the Lead retries", async () => {
    eventId = await submitRequest("E1");
    const first = await assign(eventId, "coordinator");
    expect(first.status).toBe(200);
    const retry = await assign(eventId, "coordinator");
    expect(retry.status).toBeGreaterThanOrEqual(400);

    const notices = await noticesAbout("coordinator", eventId);
    expect(notices).toHaveLength(1);
    [assignmentNotice] = notices;
    expect(assignmentNotice.title).toBe("New event coordination assignment");
    expect(assignmentNotice.message).toContain(requestId(eventId));
    expect(assignmentNotice.is_read).toBe(false);
    expect(assignmentNotice.target).toEqual({ page: "EVENT_WORKSPACE", event_id: eventId });
  });

  test("[SPM-193-TC-13] a coordinator not assigned to E1 sees, counts and marks none of its notices", async () => {
    expect(await noticesAbout("coordinatorThree", eventId)).toHaveLength(0);
    const res = await call("post", `/api/notifications/${assignmentNotice.notification_id}/read`, "coordinatorThree");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOTIFICATION_NOT_FOUND");
    expect((await call("get", `/api/events/${eventId}`, "coordinatorThree")).status).toBe(404);
  });

  test("[SPM-193-TC-04/AC3] organiser replies in an open clarification notify the coordinator once until they open it", async () => {
    const opened = await call("post", `/api/events/${eventId}/clarifications`, "coordinator",
      { message: "Please confirm the stage size.", version: await eventVersion(eventId) }, newKey());
    expect(opened.status).toBe(200);
    for (const body of ["The stage is 6 m wide.", "And 4 m deep."]) {
      const reply = await call("post", `/api/events/${eventId}/clarifications/1/messages`, "organiserA", { body }, newKey());
      expect(reply.status).toBe(201);
    }
    const replies = (await noticesAbout("coordinator", eventId)).filter((notice) => notice.title === "New clarification message");
    expect(replies).toHaveLength(1);
    expect(replies[0].message).toContain(requestId(eventId));
  });

  test("[SPM-193-TC-14] marking one and then all as read updates the unread count", async () => {
    const { unreadCount } = await inboxFor("coordinator");
    expect(unreadCount).toBeGreaterThanOrEqual(2);
    const one = await call("post", `/api/notifications/${assignmentNotice.notification_id}/read`, "coordinator");
    expect(one.status).toBe(200);
    expect(one.body.notification.is_read).toBe(true);
    expect(one.body.unreadCount).toBe(unreadCount - 1);

    const all = await call("post", "/api/notifications/read-all", "coordinator");
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ updated: unreadCount - 1, unreadCount: 0 });
    expect((await call("get", "/api/notifications/unread-count", "coordinator")).body).toEqual({ unreadCount: 0 });
  });

  test("[SPM-193-TC-02] reassignment notifies the new coordinator and tells the previous one it is no longer theirs", async () => {
    const body = { coordinatorId: userId("coordinatorTwo"), expectedCoordinatorId: userId("coordinator") };
    expect((await call("patch", `/api/events/${eventId}/coordinator`, "coordinatorLead", body)).status).toBe(200);
    const retry = await call("patch", `/api/events/${eventId}/coordinator`, "coordinatorLead", body);
    expect(retry.status).toBe(409);

    const incoming = await noticesAbout("coordinatorTwo", eventId);
    expect(incoming.map((notice) => notice.title)).toEqual(["New event coordination assignment"]);
    expect(incoming[0].type).toBe("STATUS_CHANGE");
  });

  test("[SPM-193-TC-03] the previous coordinator sees only the 'no longer assigned' notice for E1", async () => {
    const { notifications, unreadCount } = await inboxFor("coordinator");
    const about = notifications.filter((notice) => notice.event && notice.event.event_id === eventId);
    expect(about).toHaveLength(1);
    expect(about[0].type).toBe("ASSIGNMENT_ENDED");
    expect(about[0].title).toBe("Event assignment ended");
    expect(about[0].message).toBe(`Your coordinator assignment for event request ${requestId(eventId)} has ended.`);
    expect(unreadCount).toBe(1);
    const hidden = await call("post", `/api/notifications/${assignmentNotice.notification_id}/read`, "coordinator");
    expect(hidden.status).toBe(404);
  });

  test("[SPM-193-TC-11/TC-12] 'Go to Event' opens E1 for the new coordinator and is not available to the previous one", async () => {
    const [ended] = await noticesAbout("coordinator", eventId);
    expect(ended.target).toEqual({ page: "EVENT_WORKSPACE", event_id: eventId });
    expect((await call("get", `/api/events/${eventId}`, "coordinatorTwo")).status).toBe(200);
    const previous = await call("get", `/api/events/${eventId}`, "coordinator");
    expect(previous.status).toBe(404);
    expect(JSON.stringify(previous.body)).not.toContain(`spm32-${runId} E1`);
  });
});

describe("failures and other roles (SPM-193 AC11, AC12)", () => {
  test("[SPM-193-TC-15] an assignment refused for an overlapping event sends no notice", async () => {
    // coordinatorTwoBusy holds coordinatorTwo on 10 March 2027, 10:00-12:00 UTC.
    const eventId = await submitRequest("E2", { start: "2027-03-10T10:30:00Z", end: "2027-03-10T11:30:00Z" });
    const before = (await inboxFor("coordinatorTwo")).unreadCount;
    const res = await assign(eventId, "coordinatorTwo");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("COORDINATOR_CONFLICT");
    expect(await noticesAbout("coordinatorTwo", eventId)).toHaveLength(0);
    expect((await inboxFor("coordinatorTwo")).unreadCount).toBe(before);
  });

  test.each(["coordinatorLead", "venueStaff", "techSupport"])("[SPM-193-AC11] %s still gets 403 from the inbox", async (key) => {
    const res = await call("get", "/api/notifications", key);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });
});
