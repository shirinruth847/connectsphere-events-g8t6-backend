// SPM-35/SPM-37 live integration tests: real Express routes, Supabase Auth and the
// shared development database. They cover what mocks cannot: the atomic RPCs,
// constraints, round-robin locking, idempotency and real PostgREST paging.
// Every event created here is recorded in the run manifest and removed afterwards.
const crypto = require("crypto");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const runId = newRunId();
let fixtures;
const sessions = new Map();
const createdEventIds = new Set();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) {
        throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      }
      return session;
    }));
  }
  return sessions.get(key);
};

const track = (res) => {
  const eventId = res.body && res.body.event && res.body.event.eventId;
  if (eventId && !createdEventIds.has(eventId)) {
    createdEventIds.add(eventId);
    recordFixtureIds(runId, "eventIds", [eventId]);
  }
  return res;
};

const call = async (method, path, key, body, idempotencyKey) => {
  let req = request(app)[method](path).set("Authorization", `Bearer ${(await signIn(key)).access_token}`);
  if (idempotencyKey) req = req.set("Idempotency-Key", idempotencyKey);
  return track(await (body === undefined ? req : req.send(body)));
};

const newKey = () => crypto.randomUUID();
const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const titled = (label) => `spm32-${runId} ${label}`;

const validRequest = (label) => ({
  title: titled(label),
  purpose: "Annual industry conference",
  description: "Talks and networking for tech professionals.",
  startDatetime: inDays(7),
  endDatetime: inDays(7.3),
  expectedAttendance: 150,
  preferredLayoutType: "THEATRE",
  accessibilityNeeds: ["Wheelchair access"],
  isRegistrationEnabled: true,
  registrationCapacity: 150,
});

const rows = async (query, step) => {
  const { data, error } = await query;
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};

const eventRow = (eventId) =>
  rows(supabase.from("event").select("status,coordinator_id").eq("event_id", eventId).single(), "event lookup");

const activityActions = async (eventId) =>
  (await rows(
    supabase.from("activity_log").select("action").eq("entity_name", "event").eq("entity_id", eventId).order("log_id"),
    "activity lookup"
  )).map(({ action }) => action);

const notificationsFor = (eventId) =>
  rows(
    supabase.from("notification").select("title,notification_recipient(recipient_id)").eq("event_id", eventId),
    "notification lookup"
  );

const eventsTitled = async (title) =>
  (await rows(supabase.from("event").select("event_id").eq("title", title), "title lookup")).length;

const organiserEventCount = async (key) =>
  (await rows(
    supabase.from("event").select("event_id").eq("organiser_id", fixtures.accounts[key].userId),
    "organiser event lookup"
  )).length;

beforeAll(async () => {
  fixtures = await createAuthFixtures(runId);
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("POST /api/events (SPM-35)", () => {
  test("[SPM-35-TC-001] should_submit_assign_a_coordinator_and_notify_both_parties_in_one_transaction", async () => {
    const res = await call("post", "/api/events", "organiserA", validRequest("TC-001"), newKey());

    expect(res.status).toBe(201);
    const { eventId, requestId, statusLabel } = res.body.event;
    expect(requestId).toBe(`REQ-${String(eventId).padStart(6, "0")}`);
    expect(statusLabel).toBe("Pending Approval");

    const row = await eventRow(eventId);
    expect(row.status).toBe("SUBMITTED");
    expect(row.coordinator_id).not.toBeNull();
    expect(await activityActions(eventId)).toEqual(["EVENT_SUBMITTED"]);

    const notifications = await notificationsFor(eventId);
    const recipients = notifications.flatMap((item) => item.notification_recipient.map(({ recipient_id }) => recipient_id));
    expect(notifications.map(({ title }) => title).sort()).toEqual(["Event request received", "New event request assigned"]);
    expect(recipients.sort()).toEqual([fixtures.accounts.organiserA.userId, row.coordinator_id].sort());

    const list = await call("get", "/api/events/mine?status=SUBMITTED", "organiserA");
    expect(list.body.events.find((event) => event.eventId === eventId)).toEqual(
      expect.objectContaining({ requestId, statusLabel: "Pending Approval", isOwner: true })
    );
  });

  test("[SPM-35-TC-002] should_create_nothing_when_title_is_blank", async () => {
    const body = { ...validRequest("TC-002"), title: "" };
    const before = await organiserEventCount("organiserA");

    const res = await call("post", "/api/events", "organiserA", body, newKey());

    expect(res.status).toBe(400);
    expect(res.body.fields.title).toBe("Event Title is required.");
    expect(await organiserEventCount("organiserA")).toBe(before);
  });

  test("[SPM-35-TC-003] should_create_nothing_when_start_is_24_hours_ahead", async () => {
    const body = { ...validRequest("TC-003"), startDatetime: inDays(1), endDatetime: inDays(1.1) };

    const res = await call("post", "/api/events", "organiserA", body, newKey());

    expect(res.status).toBe(400);
    expect(res.body.fields.startDatetime).toBe("Event date must be at least 48 hours in advance.");
    expect(await eventsTitled(titled("TC-003"))).toBe(0);
  });

  test("[EVT-IDEM-002] should_return_the_stored_result_without_creating_a_second_event_when_a_request_is_replayed", async () => {
    const key = newKey();
    const body = validRequest("replay");

    const first = await call("post", "/api/events", "organiserA", body, key);
    const second = await call("post", "/api/events", "organiserA", body, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body.event.eventId).toBe(first.body.event.eventId);
    expect(await eventsTitled(body.title)).toBe(1);
    expect(await notificationsFor(first.body.event.eventId)).toHaveLength(2);
  });

  test("[EVT-IDEM-004] should_return_409_when_an_idempotency_key_is_reused_for_a_different_request", async () => {
    const key = newKey();
    await call("post", "/api/events", "organiserA", validRequest("key-reuse-1"), key);

    const res = await call("post", "/api/events", "organiserA", validRequest("key-reuse-2"), key);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await eventsTitled(titled("key-reuse-2"))).toBe(0);
  });

  test("[EVT-IDEM-005] should_create_exactly_one_event_when_the_same_key_is_sent_in_parallel", async () => {
    const key = newKey();
    const body = validRequest("parallel-same-key");
    await signIn("organiserA");

    const responses = await Promise.all([1, 2, 3].map(() => call("post", "/api/events", "organiserA", body, key)));

    expect(responses.map(({ status }) => status)).toEqual([201, 201, 201]);
    expect(new Set(responses.map(({ body: { event } }) => event.eventId)).size).toBe(1);
    expect(await eventsTitled(body.title)).toBe(1);
  });

  test("[EVT-CONC-001] should_rotate_coordinators_without_losing_a_submission_when_requests_run_in_parallel", async () => {
    const coordinators = await rows(
      supabase.from("user").select("user_id").eq("role", "COORDINATOR").eq("is_active", true),
      "coordinator count"
    );
    await signIn("organiserA");

    const responses = await Promise.all(
      [1, 2, 3, 4].map((n) => call("post", "/api/events", "organiserA", validRequest(`parallel-${n}`), newKey()))
    );

    expect(responses.map(({ status }) => status)).toEqual([201, 201, 201, 201]);
    const assigned = await Promise.all(responses.map(({ body: { event } }) => eventRow(event.eventId)));
    expect(assigned.every(({ coordinator_id }) => coordinator_id !== null)).toBe(true);
    expect(new Set(assigned.map(({ coordinator_id }) => coordinator_id)).size).toBe(Math.min(coordinators.length, 4));
  });
});

describe("drafts (SPM-37)", () => {
  test("[SPM-37-S1] should_save_a_title_only_draft_privately_without_a_coordinator_or_notifications", async () => {
    const res = await call("post", "/api/events/drafts", "organiserA", { title: titled("S1") }, newKey());

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Draft saved successfully.");
    const { eventId } = res.body.event;
    expect(await eventRow(eventId)).toEqual({ status: "DRAFT", coordinator_id: null });
    expect(await activityActions(eventId)).toEqual(["DRAFT_CREATED"]);
    expect(await notificationsFor(eventId)).toEqual([]);

    const otherOrganiser = await call("get", `/api/events/${eventId}`, "organiserB");
    expect(otherOrganiser.status).toBe(404);
    const otherEdit = await call("put", `/api/events/${eventId}/draft`, "organiserB", { title: "Taken over" });
    expect(otherEdit.status).toBe(404);
  });

  test("[SPM-37-S3] should_save_a_draft_when_registration_is_enabled_before_capacity_is_entered", async () => {
    const res = await call(
      "post",
      "/api/events/drafts",
      "organiserA",
      { title: titled("registration-toggle"), isRegistrationEnabled: true },
      newKey()
    );

    expect(res.status).toBe(201);
    expect(res.body.event.isRegistrationEnabled).toBe(true);
  });

  test("[EVT-REQ-004] should_store_requirements_as_numbers_when_ids_arrive_as_strings", async () => {
    const res = await call(
      "post",
      "/api/events/drafts",
      "organiserA",
      {
        title: titled("requirements"),
        venuePreferences: [String(fixtures.venue.venueId)],
        equipmentRequirements: [{ equipmentId: String(fixtures.equipmentId), quantity: "2" }],
      },
      newKey()
    );

    expect(res.status).toBe(201);
    expect(res.body.event.venuePreferences).toEqual([fixtures.venue.venueId]);
    expect(res.body.event.equipmentRequirements).toEqual([{ equipmentId: fixtures.equipmentId, quantity: 2 }]);
  });

  test("[SPM-37-S3] should_skip_the_activity_log_for_auto_saves_but_log_manual_saves", async () => {
    const created = await call("post", "/api/events/drafts", "organiserA", { title: titled("S3") }, newKey());
    const { eventId } = created.body.event;

    const autoSave = await call("put", `/api/events/${eventId}/draft`, "organiserA", { expectedAttendance: 200, isAutoSave: true });
    expect(autoSave.status).toBe(200);
    expect(autoSave.body.message).toBe("Draft auto-saved.");
    expect(autoSave.body.savedAt).toEqual(expect.any(String));
    expect(await activityActions(eventId)).toEqual(["DRAFT_CREATED"]);

    const manualSave = await call("put", `/api/events/${eventId}/draft`, "organiserA", { purpose: "Reunion" });
    expect(manualSave.status).toBe(200);
    expect(await activityActions(eventId)).toEqual(["DRAFT_CREATED", "DRAFT_UPDATED"]);
  });

  test("[SPM-37-TC-NEG-INCOMPLETE] should_keep_the_draft_unchanged_when_submitted_without_attendance", async () => {
    const created = await call("post", "/api/events/drafts", "organiserA", { title: titled("incomplete") }, newKey());
    const { eventId } = created.body.event;
    const body = validRequest("incomplete");
    delete body.expectedAttendance;

    const res = await call("put", `/api/events/${eventId}/submit`, "organiserA", body);

    expect(res.status).toBe(400);
    expect(res.body.fields.expectedAttendance).toBe("Expected Attendance is required for submission");
    expect(await eventRow(eventId)).toEqual({ status: "DRAFT", coordinator_id: null });
    expect(await notificationsFor(eventId)).toEqual([]);
  });

  test("[SPM-37-S4] should_submit_a_resumed_draft_and_reject_later_draft_edits", async () => {
    const created = await call("post", "/api/events/drafts", "organiserA", { title: titled("S4") }, newKey());
    const { eventId } = created.body.event;
    const loaded = await call("get", `/api/events/${eventId}`, "organiserA");
    expect(loaded.body.event).toEqual(expect.objectContaining({ title: titled("S4"), isOwner: true }));

    const submitted = await call("put", `/api/events/${eventId}/submit`, "organiserA", validRequest("S4"));

    expect(submitted.status).toBe(200);
    expect(submitted.body.event.statusLabel).toBe("Pending Approval");
    expect(await notificationsFor(eventId)).toHaveLength(2);
    expect(await activityActions(eventId)).toEqual(["DRAFT_CREATED", "EVENT_SUBMITTED"]);

    const lateEdit = await call("put", `/api/events/${eventId}/draft`, "organiserA", { title: "Too late" });
    expect(lateEdit.status).toBe(409);
    expect(lateEdit.body.code).toBe("EVENT_NOT_DRAFT");
  });
});

describe("GET /api/events/mine paging against real PostgREST timestamps", () => {
  test("[TC-AUTH-021] should_visit_every_draft_once_when_following_next_cursor", async () => {
    const all = await call("get", "/api/events/mine?status=DRAFT", "organiserA");
    const allIds = all.body.events.map(({ eventId }) => eventId);
    const pagedIds = [];
    let cursor = null;
    do {
      const page = await call("get", `/api/events/mine?status=DRAFT&limit=2${cursor ? `&cursor=${cursor}` : ""}`, "organiserA");
      expect(page.status).toBe(200);
      pagedIds.push(...page.body.events.map(({ eventId }) => eventId));
      cursor = page.body.nextCursor;
    } while (cursor && pagedIds.length <= allIds.length);

    expect(allIds.length).toBeGreaterThan(2);
    expect(pagedIds).toEqual(allIds);
  });
});
