// SPM-246 (SPM-243 AC2; TC-03, TC-04, TC-07 access part): what a Safety Officer
// can open, see and change on the event API. Needs TEST_DATABASE_URL.
const request = require("supertest");
const app = require("../../server");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures } = require("../fixtures/authFixtures");
const { withPrivilegedDb, cleanupLifecycleRows } = require("../fixtures/lifecycleFixtures");
const { SAFETY_ACCOUNTS, createReviewEvent, registerAttendees } = require("../fixtures/safetyFixtures");

jest.setTimeout(180000);

const runId = newRunId();
const eventIds = [];
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

const userId = (key) => fixtures.accounts[key].userId;

beforeAll(async () => {
  await require("../fixtures/adminCleanup").assertAuditCleanupAvailable();
  fixtures = await createAuthFixtures(runId, {
    extraAccounts: [...SAFETY_ACCOUNTS, { key: "attendeeTwo", role: "ATTENDEE" }, { key: "attendeeThree", role: "ATTENDEE" }],
  });
});

afterAll(async () => {
  if (fixtures) await cleanupLifecycleRows(runId, eventIds);
  await cleanupAuthFixtures(runId);
});

describe("SPM-246 Safety Officer access scope", () => {
  test("[SPM-243-TC-03] an unrelated event is not found; a held one shows counts but no participants", async () => {
    const { event: unrelated } = await createReviewEvent(fixtures, eventIds, { status: "PLANNING", round: null });
    const { event: held } = await createReviewEvent(fixtures, eventIds, { round: { claimedBy: userId("safetyOfficer") } });
    await registerAttendees(fixtures, held, ["attendee", "attendeeTwo", "attendeeThree"]);

    const hidden = await call("get", `/api/events/${unrelated.event_id}`, "safetyOfficer");
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("EVENT_NOT_FOUND");

    const res = await call("get", `/api/events/${held.event_id}`, "safetyOfficer");
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ viewerRelationship: "SAFETY_OFFICER", registeredCount: 3, status: "SAFETY_REVIEW" });
    const body = JSON.stringify(res.body);
    for (const key of ["attendee", "attendeeTwo", "attendeeThree"]) {
      expect(body).not.toContain(fixtures.accounts[key].email);
    }
    expect(res.body.event).not.toHaveProperty("organiser");
  });

  test("[SPM-243-AC2] another officer's round is hidden; the open queue and decided rounds are visible", async () => {
    const { event: heldByOther } = await createReviewEvent(fixtures, eventIds, { round: { claimedBy: userId("safetyOfficerTwo") } });
    const { event: queued } = await createReviewEvent(fixtures, eventIds);
    const { event: decided } = await createReviewEvent(fixtures, eventIds, {
      status: "PLANNING",
      round: { status: "CHANGES_REQUESTED", claimedBy: userId("safetyOfficer"), decidedBy: userId("safetyOfficer") },
    });

    expect((await call("get", `/api/events/${heldByOther.event_id}`, "safetyOfficer")).status).toBe(404);
    expect((await call("get", `/api/events/${queued.event_id}`, "safetyOfficer")).status).toBe(200);
    expect((await call("get", `/api/events/${decided.event_id}`, "safetyOfficer")).status).toBe(200);
    expect((await call("get", `/api/events/${decided.event_id}`, "safetyOfficerTwo")).status).toBe(404);
  });

  test("[SPM-243-TC-04] editing the event or confirming it is forbidden and changes nothing", async () => {
    const { event } = await createReviewEvent(fixtures, eventIds, { round: { claimedBy: userId("safetyOfficer") } });
    const edit = await call("put", `/api/events/${event.event_id}`, "safetyOfficer", { title: "Renamed", version: event.version });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe("FORBIDDEN");

    const confirm = await call("post", `/api/events/${event.event_id}/confirm`, "safetyOfficer", { version: event.version });
    expect(confirm.status).toBe(403);

    const after = await call("get", `/api/events/${event.event_id}`, "safetyOfficer");
    expect(after.body.event).toMatchObject({ title: event.title, status: "SAFETY_REVIEW", version: event.version });
  });

  test("[SPM-243-AC2] history is limited to review-relevant and safety entries", async () => {
    const { event } = await createReviewEvent(fixtures, eventIds, { round: { claimedBy: userId("safetyOfficer") } });
    // System-written entries, so cleanupLifecycleRows removes them with the event.
    await withPrivilegedDb((client) => client.query(
      `INSERT INTO public.activity_log (user_id, entity_name, entity_id, action, details, actor_role, changes, audience) VALUES
         (NULL, 'event', $1, 'EVENT_DETAILS_UPDATED', 'Title changed.', 'SYSTEM', '{"title": {"before": "a", "after": "b"}}', 'ORGANISER_SAFE'),
         (NULL, 'event', $1, 'EVENT_DETAILS_UPDATED', 'Attendance changed.', 'SYSTEM', '{"expectedAttendance": {"before": 50, "after": 80}}', 'ORGANISER_SAFE'),
         (NULL, 'event', $1, 'SAFETY_REVIEW_SUBMITTED', 'Submitted for safety review.', 'SYSTEM', '{"status": {"before": "PLANNING", "after": "SAFETY_REVIEW"}}', 'STAFF_ONLY'),
         (NULL, 'event', $1, 'COORDINATOR_ASSIGNED', 'Coordinator assigned.', 'SYSTEM', NULL, 'STAFF_ONLY')`,
      [event.event_id]
    ));

    const officer = await call("get", `/api/events/${event.event_id}/history`, "safetyOfficer");
    expect(officer.status).toBe(200);
    expect(officer.body.history.map((entry) => entry.summary).sort()).toEqual(["Attendance changed.", "Submitted for safety review."]);

    const coordinator = await call("get", `/api/events/${event.event_id}/history`, "coordinator");
    expect(coordinator.body.history).toHaveLength(4);
  });
});
