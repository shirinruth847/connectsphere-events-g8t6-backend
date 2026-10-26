process.env.ENABLE_COORDINATOR_WORKFLOWS = "true";
// SPM-192 against real Supabase Auth, PostgREST and the notification
// functions: organiser visibility, wording of the triggers that exist on main,
// read state and retries. Needs migration 20261026043658 and TEST_DATABASE_URL.
// Feasibility, rejection and cancellation have no workflow yet; their notices
// are tested in tests/database/spm192OrganiserNotifications.test.cjs. The
// confirmation notice is covered live by SPM-173-TC-16.
//
// One request (E1) goes through the loop in order, so the tests in the first
// block must run in this file's order. Fixtures are spm32-<run> accounts and
// events, removed after the run with their notifications.
const crypto = require("node:crypto");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { withCleanupConnection } = require("../fixtures/adminCleanup");

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
const asOwner = (sql, values = []) => withCleanupConnection(async (client) => (await client.query(sql, values)).rows);

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

const validRequest = (label) => ({
  title: `spm32-${runId} ${label}`,
  purpose: "Synthetic organiser notification check",
  description: "Talks and networking for the SPM-192 run.",
  startDatetime: inDays(640),
  endDatetime: inDays(640.1),
  expectedAttendance: 80,
  preferredLayoutType: "THEATRE",
  accessibilityNeeds: [],
  isRegistrationEnabled: false,
});

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for the organiser notification tests.");
  fixtures = await createAuthFixtures(runId);
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("an organiser's request through its notifications (SPM-192)", () => {
  let eventId;

  test("[SPM-192-TC-13] a submission that fails validation creates no notification", async () => {
    const before = (await inboxFor("organiserA")).unreadCount;
    const res = await call("post", "/api/events", "organiserA", { ...validRequest("Invalid"), title: "" }, newKey());
    expect(res.status).toBe(400);
    expect((await inboxFor("organiserA")).unreadCount).toBe(before);
  });

  test("[SPM-192-TC-01/TC-14] submitting notifies the owner once with the request ID, even when retried", async () => {
    const key = newKey();
    const body = validRequest("E1");
    const first = await call("post", "/api/events", "organiserA", body, key);
    expect(first.status).toBe(201);
    eventId = first.body.event.eventId;
    recordFixtureIds(runId, "eventIds", [eventId]);

    const retry = await call("post", "/api/events", "organiserA", body, key);
    expect([200, 201]).toContain(retry.status);
    expect(retry.body.event.eventId).toBe(eventId);

    const notices = await noticesAbout("organiserA", eventId);
    expect(notices).toHaveLength(1);
    expect(notices[0].message).toContain(requestId(eventId));
    expect(notices[0].is_read).toBe(false);
  });

  test("[SPM-192-TC-05] the Lead's assignment notice names the coordinator", async () => {
    const res = await call("post", `/api/events/${eventId}/coordinator`, "coordinatorLead", { coordinatorId: userId("coordinator") });
    expect(res.status).toBe(200);
    const [latest] = await noticesAbout("organiserA", eventId);
    expect(latest.title).toBe("Event coordinator assigned");
    expect(latest.message).toContain("spm32 coordinator");
  });

  test("[SPM-192-TC-07] a coordinator's edit tells the owner their event was updated", async () => {
    const res = await call("put", `/api/events/${eventId}`, "coordinator",
      { description: "Edited by the coordinator for SPM-192.", version: await eventVersion(eventId) }, newKey());
    expect(res.status).toBe(200);
    const [latest] = await noticesAbout("organiserA", eventId);
    expect(latest.title).toBe("Event details updated");
    expect(latest.message).toContain("description");
  });

  test("[SPM-192-TC-02] a clarification request reaches the owner with its message", async () => {
    const message = "Please confirm attendance.";
    const res = await call("post", `/api/events/${eventId}/clarifications`, "coordinator",
      { message, version: await eventVersion(eventId) }, newKey());
    expect(res.status).toBe(200);
    const [latest] = await noticesAbout("organiserA", eventId);
    expect(latest.title).toBe("Clarification requested");
    expect(latest.message).toContain(message);
  });

  test("[SPM-192-TC-06] the reassignment notice carries no internal details", async () => {
    const res = await call("patch", `/api/events/${eventId}/coordinator`, "coordinatorLead", {
      coordinatorId: userId("coordinatorTwo"),
      expectedCoordinatorId: userId("coordinator"),
    });
    expect(res.status).toBe(200);
    const [latest] = await noticesAbout("organiserA", eventId);
    expect(latest.title).toBe("Event coordinator changed");
    expect(latest.message).not.toMatch(/previousCoordinatorId|reason|spm32 coordinator(?!Two)/i);
  });

  test("[SPM-192-TC-06/AC4] the reassignment notice names the new coordinator as the point of contact", async () => {
    const [latest] = await noticesAbout("organiserA", eventId);
    expect(latest.title).toBe("Event coordinator changed");
    expect(latest.message).toBe(
      `Your event request ${requestId(eventId)} "spm32-${runId} E1" has a new coordinator, spm32 coordinatorTwo, who is now your point of contact.`
    );
    expect(latest.message).not.toMatch(/reason|previous/i);
  });

  test("[SPM-192-TC-09/AC9] every notice is newest first and opens the event workspace with the latest status", async () => {
    const notices = await noticesAbout("organiserA", eventId);
    // Submission, assignment, edit and reassignment (plus TC-02's once enabled).
    expect(notices.length).toBeGreaterThanOrEqual(4);
    const times = notices.map((notice) => Date.parse(notice.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    for (const notice of notices) {
      expect(notice.target).toEqual({ page: "EVENT_WORKSPACE", event_id: eventId });
      expect(notice.event.title).toBe(`spm32-${runId} E1`);
      expect(notice).not.toHaveProperty("recipients");
    }
    const workspace = await call("get", `/api/events/${eventId}`, "organiserA");
    expect(workspace.status).toBe(200);
    expect(workspace.body.event.statusLabel).toBe("Under Review");
  });

  test("[SPM-192-TC-10] a same-organisation organiser neither receives nor can mark the owner's notices", async () => {
    expect(await noticesAbout("organiserA2", eventId)).toHaveLength(0);
    const [ownersNotice] = await noticesAbout("organiserA", eventId);
    const res = await call("post", `/api/notifications/${ownersNotice.notification_id}/read`, "organiserA2");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOTIFICATION_NOT_FOUND");
  });

  test("[SPM-192-TC-12] marking one and then all as read updates the unread count", async () => {
    const { notifications, unreadCount } = await inboxFor("organiserA");
    const target = notifications.find((notice) => !notice.is_read);
    const one = await call("post", `/api/notifications/${target.notification_id}/read`, "organiserA");
    expect(one.status).toBe(200);
    expect(one.body.notification.is_read).toBe(true);
    expect(one.body.unreadCount).toBe(unreadCount - 1);

    const all = await call("post", "/api/notifications/read-all", "organiserA");
    expect(all.status).toBe(200);
    expect(all.body).toEqual({ updated: unreadCount - 1, unreadCount: 0 });
    const badge = await call("get", "/api/notifications/unread-count", "organiserA");
    expect(badge.body).toEqual({ unreadCount: 0 });
  });
});

describe("notifications about events the organiser does not own (SPM-192 AC8)", () => {
  test("[SPM-192-TC-11] a notice about another organiser's event is not listed, counted or markable", async () => {
    const othersEvent = fixtures.events.otherOrganisation;
    // Addressed to organiserA as a faulty writer might; only the owner may see it.
    const [{ id }] = await asOwner(
      `SELECT public._notify_event_users($1, 'Not yours', 'About E3', ARRAY[$2, $3]::integer[], 'STATUS_CHANGE', $4, NULL) AS id`,
      [othersEvent, userId("organiserA"), userId("organiserB"), `SPM_TEST:spm192:${runId}:e3`]
    );
    const before = await inboxFor("organiserA");
    expect(before.notifications.map((notice) => notice.notification_id)).not.toContain(id);

    const mark = await call("post", `/api/notifications/${id}/read`, "organiserA");
    expect(mark.status).toBe(404);
    await call("post", "/api/notifications/read-all", "organiserA");
    const [row] = await asOwner(
      "SELECT is_read FROM public.notification_recipient WHERE notification_id = $1 AND recipient_id = $2",
      [id, userId("organiserA")]
    );
    expect(row.is_read).toBe(false);
    expect((await inboxFor("organiserA")).unreadCount).toBe(0);

    expect((await inboxFor("organiserB")).notifications.map((notice) => notice.notification_id)).toContain(id);
  });

  test("[SPM-192] staff roles still get 403 until SPM-193", async () => {
    for (const key of ["coordinator", "coordinatorLead", "venueStaff", "techSupport"]) {
      expect((await call("get", "/api/notifications", key)).status).toBe(403);
    }
  });
});
