// SPM-33 live integration tests: real Express routes, Supabase Auth and the shared
// development database. They cover what mocks cannot: the row lock that decides
// between two saves, reassignment racing an edit, idempotent retries, the history
// columns filled by the database and the privileges that keep history append-only.
// Needs the four spm33 migrations (event_edit_history, owner_history_and_edit_notice,
// request_organisation_and_history_retention, assignment_enters_under_review).
// Tests share fixture events and run
// in file order; every record is listed in the run manifest and removed afterwards.
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

const call = async (method, path, key, body, idempotencyKey) => {
  let req = request(app)[method](path).set("Authorization", `Bearer ${(await signIn(key)).access_token}`);
  if (idempotencyKey) req = req.set("Idempotency-Key", idempotencyKey);
  return body === undefined ? req : req.send(body);
};

const newKey = () => crypto.randomUUID();
const titled = (label) => `spm32-${runId} ${label}`;
const userId = (key) => fixtures.accounts[key].userId;

const rows = async (query, step) => {
  const { data, error } = await query;
  if (error) throw new Error(`${step} failed: ${error.message}`);
  return data;
};

const eventState = (eventId) =>
  rows(
    supabase
      .from("event")
      .select("title,purpose,description,status,version,coordinator_id,expected_attendance,start_datetime")
      .eq("event_id", eventId)
      .single(),
    "event lookup"
  );

const storedHistory = (eventId) =>
  rows(
    supabase
      .from("activity_log")
      .select("log_id,user_id,action,actor_role,audience,changes")
      .eq("entity_name", "event")
      .eq("entity_id", eventId)
      .order("log_id"),
    "history lookup"
  );

const notificationCount = async (eventId) =>
  (await rows(supabase.from("notification").select("notification_id").eq("event_id", eventId), "notification lookup")).length;

const editNotices = (eventId) =>
  rows(
    supabase
      .from("notification")
      .select("message,type,notification_recipient(recipient_id)")
      .eq("event_id", eventId)
      .eq("title", "Event details updated")
      .order("notification_id"),
    "edit notice lookup"
  );

const inDays = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

// Fixture setup only: moves a synthetic event this run created to the status a test needs.
const setStatus = (eventId, status) =>
  rows(supabase.from("event").update({ status }).eq("event_id", eventId).like("title", `spm32-${runId}%`).select("event_id"), `set ${status}`);

// The fixtures record coordinatorLead as each event's supervising Lead, and only
// that Lead may reassign (SPM-174).
const reassign = (eventId, fromKey, toKey) =>
  supabase.rpc("reassign_event_coordinator", {
    p_event_id: eventId,
    p_coordinator_id: userId(toKey),
    p_expected_coordinator_id: userId(fromKey),
    p_lead_id: userId("coordinatorLead"),
  });

const loadEvent = async (key, eventId) => {
  const res = await call("get", `/api/events/${eventId}`, key);
  if (res.status !== 200) throw new Error(`${key} could not load event ${eventId}: ${res.status}`);
  return res.body.event;
};

const historyFor = async (key, eventId) => {
  const res = await call("get", `/api/events/${eventId}/history`, key);
  if (res.status !== 200) throw new Error(`${key} could not load history of ${eventId}: ${res.status}`);
  return res.body.history;
};

beforeAll(async () => {
  fixtures = await createAuthFixtures(runId, {
    extraAccounts: [{ key: "coordinator2", role: "COORDINATOR" }],
  });
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("viewing by role and relationship (AC1)", () => {
  test("[SPM-33-TC-01] should_show_the_full_draft_when_the_owner_opens_it", async () => {
    const res = await call("get", `/api/events/${fixtures.events.ownDraft}`, "organiserA");

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual(
      expect.objectContaining({
        statusLabel: "Draft",
        title: titled("ownDraft"),
        expectedAttendance: 50,
        isOwner: true,
        viewerRelationship: "OWNER",
        version: expect.any(Number),
      })
    );
    // Organisers get the label only since SPM-173.
    expect(res.body.event).not.toHaveProperty("status");
    expect(res.body.event.permissions.canEdit).toBe(true);
  });

  test("[SPM-33-TC-02] should_hide_a_colleagues_draft_from_search_direct_links_and_edits", async () => {
    const eventId = fixtures.events.ownDraft;

    const list = await call("get", "/api/events/mine?limit=100", "organiserA2");
    expect(list.status).toBe(200);
    expect(list.body.events.map((event) => event.eventId)).not.toContain(eventId);

    for (const res of [
      await call("get", `/api/events/${eventId}`, "organiserA2"),
      await call("get", `/api/events/${eventId}/history`, "organiserA2"),
      await call("put", `/api/events/${eventId}`, "organiserA2", { title: "Taken over", version: 1 }, newKey()),
      await call("put", `/api/events/${eventId}/draft`, "organiserA2", { title: "Taken over" }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Event request not found.", code: "EVENT_NOT_FOUND" });
    }
    expect((await eventState(eventId)).title).toBe(titled("ownDraft"));
  });

  test("[SPM-33-TC-03] should_give_a_same_organisation_organiser_a_read_only_view_without_staff_history", async () => {
    const eventId = fixtures.events.ownSubmitted;

    const event = await loadEvent("organiserA2", eventId);

    expect(event).toEqual(expect.objectContaining({ isOwner: false, viewerRelationship: "ORGANISATION_MEMBER" }));
    expect(event.permissions).toEqual({
      canEdit: false,
      editableFields: [],
      canViewDraftHistory: false,
      canViewStaffHistory: false,
    });
    for (const hidden of ["coordinatorId", "organiser", "registrations", "participants"]) {
      expect(event).not.toHaveProperty(hidden);
    }
    const history = await historyFor("organiserA2", eventId);
    expect(history.every((entry) => entry.audience === "ORGANISER_SAFE")).toBe(true);
  });

  test("[SPM-33-TC-04] should_return_404_when_the_event_belongs_to_another_organisation", async () => {
    const res = await call("get", `/api/events/${fixtures.events.otherOrganisation}`, "organiserA");

    expect(res.status).toBe(404);
  });

  // The fixtures above are placed in an organisation directly; this one goes through
  // the API, so it proves the database files a real request under the organiser's
  // organisation (SPM-33 review finding: nothing set organisation_id before).
  test("[SPM-33-TC-03] should_show_a_request_submitted_through_the_api_to_a_same_organisation_organiser", async () => {
    const created = await call(
      "post",
      "/api/events",
      "organiserA",
      {
        title: titled("submitted through the API"),
        purpose: "Shared with the organisation once submitted.",
        description: "Created by the SPM-33 organisation test.",
        startDatetime: inDays(8),
        endDatetime: inDays(8.1),
        expectedAttendance: 30,
        preferredLayoutType: "NO_PREFERENCE",
      },
      newKey()
    );
    expect(created.status).toBe(201);
    const { eventId } = created.body.event;
    recordFixtureIds(runId, "eventIds", [eventId]);

    const stored = await rows(supabase.from("event").select("organisation_id").eq("event_id", eventId).single(), "organisation lookup");
    expect(stored.organisation_id).toBe(fixtures.organisations.A);
    expect(await loadEvent("organiserA2", eventId)).toEqual(
      expect.objectContaining({ isOwner: false, viewerRelationship: "ORGANISATION_MEMBER" })
    );
    expect((await call("get", `/api/events/${eventId}`, "organiserB")).status).toBe(404);
  });

  test("[SPM-33-TC-05] should_give_the_assigned_coordinator_the_coordination_view_and_history", async () => {
    const eventId = fixtures.events.ownSubmitted;

    const event = await loadEvent("coordinator", eventId);

    expect(event).toEqual(
      expect.objectContaining({
        viewerRelationship: "ASSIGNED_COORDINATOR",
        coordinatorId: userId("coordinator"),
        organiser: { userId: userId("organiserA"), name: "spm32 organiserA" },
        purpose: "Internal planning purpose that attendees must not see",
      })
    );
    // ownSubmitted is still SUBMITTED, where coordinators may not edit (Master v1.0
    // section 5.2, ead807c); TC-10 covers the editable UNDER_REVIEW case.
    expect(event.permissions).toEqual({
      canEdit: false,
      editableFields: [],
      canViewDraftHistory: false,
      canViewStaffHistory: true,
    });
    expect((await call("get", `/api/events/${eventId}/history`, "coordinator")).status).toBe(200);
  });

  test.each(["coordinator2", "venueStaff", "techSupport"])(
    "[SPM-33-TC-06] should_return_404_for_the_event_and_its_history_when_%s_opens_it",
    async (key) => {
      const eventId = fixtures.events.ownSubmitted;

      expect((await call("get", `/api/events/${eventId}`, key)).status).toBe(404);
      expect((await call("get", `/api/events/${eventId}/history`, key)).status).toBe(404);
    }
  );

  test("[SPM-33-AC8] should_answer_400_for_a_history_cursor_the_api_did_not_issue", async () => {
    // Well-formed base64url, so it passes the route's format check and reaches the model.
    const cursor = Buffer.from(JSON.stringify({ logId: "8" })).toString("base64url");

    const res = await call("get", `/api/events/${fixtures.events.ownSubmitted}/history?cursor=${cursor}`, "coordinator");

    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({ code: "VALIDATION_FAILED", fields: { cursor: "Invalid page cursor." } })
    );
  });
});

describe("organiser edits (AC2, AC3, AC7)", () => {
  test("[SPM-33-TC-07] should_save_a_manual_draft_edit_and_record_it_in_history", async () => {
    const eventId = fixtures.events.ownDraft;
    const { version } = await loadEvent("organiserA", eventId);

    const res = await call("put", `/api/events/${eventId}`, "organiserA", { expectedAttendance: 200, version }, newKey());

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual(expect.objectContaining({ statusLabel: "Draft", expectedAttendance: 200, version: version + 1 }));
    expect(res.body.event).not.toHaveProperty("status");
    const [latest] = await historyFor("organiserA", eventId);
    expect(latest).toEqual(
      expect.objectContaining({
        action: "DRAFT_UPDATED",
        actor: { userId: userId("organiserA"), name: "spm32 organiserA", role: "ORGANISER" },
        occurredAt: expect.any(String),
        changes: [{ field: "expectedAttendance", before: 50, after: 200 }],
      })
    );
  });

  test("[SPM-33-TC-08] should_save_an_auto_save_without_a_history_entry", async () => {
    const eventId = fixtures.events.ownDraft;
    const before = (await storedHistory(eventId)).length;

    const res = await call("put", `/api/events/${eventId}/draft`, "organiserA", { expectedAttendance: 250, isAutoSave: true });

    expect(res.status).toBe(200);
    expect((await eventState(eventId)).expected_attendance).toBe(250);
    expect(await storedHistory(eventId)).toHaveLength(before);
  });

  test("[SPM-33-AC7] should_block_a_draft_save_made_from_an_older_version_and_return_the_current_values", async () => {
    const eventId = fixtures.events.ownDraft;
    const { version } = await loadEvent("organiserA", eventId);
    const saved = await call("put", `/api/events/${eventId}`, "organiserA", { purpose: "First tab", version }, newKey());
    expect(saved.status).toBe(200);

    const stale = await call("put", `/api/events/${eventId}`, "organiserA", { title: titled("stale tab"), version }, newKey());

    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("EVENT_VERSION_CONFLICT");
    expect(stale.body.event).toEqual(expect.objectContaining({ purpose: "First tab", title: titled("ownDraft"), version: version + 1 }));
    expect((await eventState(eventId)).title).toBe(titled("ownDraft"));
  });

  test("[SPM-33-AC7] should_replay_a_retried_draft_save_without_a_second_history_entry", async () => {
    const eventId = fixtures.events.ownDraft;
    const { version } = await loadEvent("organiserA", eventId);
    const key = newKey();
    const body = { description: "Saved once", version };

    const first = await call("put", `/api/events/${eventId}`, "organiserA", body, key);
    const before = (await storedHistory(eventId)).length;
    const retry = await call("put", `/api/events/${eventId}`, "organiserA", body, key);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.event.version).toBe(first.body.event.version);
    expect(await storedHistory(eventId)).toHaveLength(before);
  });

  test("[SPM-33-AC2] should_show_history_from_before_submission_to_the_owner_only", async () => {
    const draftPurpose = `spm33-${runId} purpose while still a private draft`;
    const created = await call("post", "/api/events/drafts", "organiserA", { title: titled("draft history"), purpose: draftPurpose }, newKey());
    expect(created.status).toBe(201);
    const { eventId, version } = created.body.event;
    recordFixtureIds(runId, "eventIds", [eventId]);

    const saved = await call("put", `/api/events/${eventId}`, "organiserA", { purpose: "Purpose at submission", version }, newKey());
    expect(saved.status).toBe(200);
    const submitted = await call("put", `/api/events/${eventId}/submit`, "organiserA", {
      description: "Submitted for review.",
      startDatetime: inDays(7),
      endDatetime: inDays(7.2),
      expectedAttendance: 40,
      preferredLayoutType: "NO_PREFERENCE",
    });
    expect(submitted.status).toBe(200);
    // The database files the request under organiserA's only organisation. Fixture
    // setup still places the coordinator: assignment through the API is SPM-177's.
    const [placed] = await rows(
      supabase
        .from("event")
        .update({ coordinator_id: userId("coordinator") })
        .eq("event_id", eventId)
        .like("title", `spm32-${runId}%`)
        .select("event_id,organisation_id"),
      "place submitted event"
    );
    expect(placed.organisation_id).toBe(fixtures.organisations.A);

    const ownerHistory = await historyFor("organiserA", eventId);
    expect(ownerHistory.map((entry) => entry.action)).toEqual(["EVENT_SUBMITTED", "DRAFT_UPDATED", "DRAFT_CREATED"]);
    expect(ownerHistory[1]).toEqual(
      expect.objectContaining({
        audience: "OWNER_ONLY",
        changes: [{ field: "purpose", before: draftPurpose, after: "Purpose at submission" }],
      })
    );
    expect((await loadEvent("organiserA", eventId)).permissions).toEqual(
      expect.objectContaining({ canViewDraftHistory: true, canViewStaffHistory: false })
    );

    // A colleague and the assigned coordinator see the request, but nothing of the draft.
    for (const key of ["organiserA2", "coordinator"]) {
      const event = await loadEvent(key, eventId);
      expect(event.permissions.canViewDraftHistory).toBe(false);
      const response = await call("get", `/api/events/${eventId}/history?limit=100`, key);
      expect(response.status).toBe(200);
      expect(response.body.history.map((entry) => entry.action)).toEqual(["EVENT_SUBMITTED"]);
      expect(JSON.stringify(response.body)).not.toContain(draftPurpose);
    }
  });

  test("[SPM-33-TC-09] should_deny_the_owner_a_direct_edit_after_submission_and_point_to_a_change_request", async () => {
    const eventId = fixtures.events.ownSubmitted;
    const before = await eventState(eventId);

    const direct = await call("put", `/api/events/${eventId}`, "organiserA", { title: "Edited directly", version: before.version }, newKey());
    const draftRoute = await call("put", `/api/events/${eventId}/draft`, "organiserA", { title: "Edited directly" });

    for (const res of [direct, draftRoute]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("EDIT_REQUIRES_CHANGE_REQUEST");
      expect(res.body.error).toMatch(/Request a change/);
    }
    expect(await eventState(eventId)).toEqual(before);
  });

  test("[SPM-33-AC3] should_deny_a_same_organisation_organiser_any_edit_of_a_submitted_event", async () => {
    const eventId = fixtures.events.ownSubmitted;
    const before = await eventState(eventId);

    const direct = await call("put", `/api/events/${eventId}`, "organiserA2", { title: "Taken over", version: before.version }, newKey());
    const draftRoute = await call("put", `/api/events/${eventId}/draft`, "organiserA2", { title: "Taken over" });

    for (const res of [direct, draftRoute]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("EVENT_READ_ONLY");
    }
    expect(await eventState(eventId)).toEqual(before);
  });
});

describe("assigned coordinator edits (AC4-AC8)", () => {
  let eventId;

  beforeAll(async () => {
    eventId = fixtures.events.ownSubmitted;
    await setStatus(eventId, "UNDER_REVIEW");
  });

  test("[SPM-33-TC-10] should_save_an_ordinary_field_and_record_the_coordinator_in_history", async () => {
    const { version, description } = await loadEvent("coordinator", eventId);
    const notifications = await notificationCount(eventId);

    const res = await call("put", `/api/events/${eventId}`, "coordinator", { description: "Clarified by the coordinator.", version }, newKey());

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Event details updated.");
    expect(res.body.event).toEqual(expect.objectContaining({ description: "Clarified by the coordinator.", version: version + 1 }));
    expect((await eventState(eventId)).description).toBe("Clarified by the coordinator.");

    // The owner sees the change: who made it, in which role, and the values.
    const [latest] = await historyFor("organiserA", eventId);
    expect(latest).toEqual(
      expect.objectContaining({
        action: "EVENT_DETAILS_UPDATED",
        actor: { userId: userId("coordinator"), name: "spm32 coordinator", role: "COORDINATOR" },
        changes: [{ field: "description", before: description, after: "Clarified by the coordinator." }],
      })
    );

    // The owner alone is notified, told which detail changed but not its value.
    expect(await notificationCount(eventId)).toBe(notifications + 1);
    const notices = await editNotices(eventId);
    expect(notices).toHaveLength(1);
    expect(notices[0].type).toBe("STATUS_CHANGE");
    expect(notices[0].notification_recipient).toEqual([{ recipient_id: userId("organiserA") }]);
    expect(notices[0].message).toMatch(/updated the description of event request REQ-\d{6}\./);
    expect(notices[0].message).not.toContain("Clarified by the coordinator.");
  });

  test("[SPM-33-TC-11] should_save_nothing_when_a_significant_field_is_sent_with_an_ordinary_one", async () => {
    const before = await eventState(eventId);

    const res = await call(
      "put",
      `/api/events/${eventId}`,
      "coordinator",
      { title: titled("renamed"), startDatetime: "2027-06-01T09:00:00+08:00", version: before.version },
      newKey()
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FIELD_NOT_EDITABLE");
    expect(res.body.fields).toHaveProperty("startDatetime");
    expect(await eventState(eventId)).toEqual(before);
  });

  test("[SPM-33-TC-16][SPM-33-TC-21] should_reject_a_blank_title_without_a_change_a_history_entry_or_a_notification", async () => {
    const before = await eventState(eventId);
    const entries = (await storedHistory(eventId)).length;
    const notifications = await notificationCount(eventId);

    const res = await call("put", `/api/events/${eventId}`, "coordinator", { title: "", version: before.version }, newKey());

    expect(res.status).toBe(400);
    expect(res.body.fields.title).toBe("Event Title is required.");
    expect(await eventState(eventId)).toEqual(before);
    expect(await storedHistory(eventId)).toHaveLength(entries);
    expect(await notificationCount(eventId)).toBe(notifications);
  });

  test("[SPM-33-TC-17] should_block_the_second_tab_with_409_and_the_current_values", async () => {
    const { version, title } = await loadEvent("coordinator", eventId);

    const firstTab = await call("put", `/api/events/${eventId}`, "coordinator", { description: "Saved from tab one.", version }, newKey());
    const secondTab = await call("put", `/api/events/${eventId}`, "coordinator", { title: titled("tab two"), version }, newKey());

    expect(firstTab.status).toBe(200);
    expect(secondTab.status).toBe(409);
    expect(secondTab.body.code).toBe("EVENT_VERSION_CONFLICT");
    expect(secondTab.body.event).toEqual(expect.objectContaining({ description: "Saved from tab one.", title, version: version + 1 }));
    expect((await eventState(eventId)).title).toBe(title);
  });

  test("[SPM-33-TC-18] should_return_the_original_result_once_when_the_same_request_is_retried", async () => {
    const { version } = await loadEvent("coordinator", eventId);
    const key = newKey();
    const body = { description: "Saved with key K.", version };
    const entries = (await storedHistory(eventId)).length;
    const notifications = await notificationCount(eventId);

    const first = await call("put", `/api/events/${eventId}`, "coordinator", body, key);
    const retry = await call("put", `/api/events/${eventId}`, "coordinator", body, key);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.event.version).toBe(version + 1);
    expect((await eventState(eventId)).version).toBe(version + 1);
    expect(await storedHistory(eventId)).toHaveLength(entries + 1);
    // One notification for the one change; the retry sends no second one.
    expect(await notificationCount(eventId)).toBe(notifications + 1);

    const reused = await call("put", `/api/events/${eventId}`, "coordinator", { description: "Different body.", version: version + 1 }, key);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("[SPM-33-CONC-001] should_apply_exactly_one_of_two_saves_made_in_parallel_from_the_same_version", async () => {
    const { version } = await loadEvent("coordinator", eventId);
    const entries = (await storedHistory(eventId)).length;
    const notifications = await notificationCount(eventId);

    const responses = await Promise.all([
      call("put", `/api/events/${eventId}`, "coordinator", { description: "Parallel save one.", version }, newKey()),
      call("put", `/api/events/${eventId}`, "coordinator", { description: "Parallel save two.", version }, newKey()),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const winner = responses.find(({ status }) => status === 200);
    const after = await eventState(eventId);
    expect(after.version).toBe(version + 1);
    expect(after.description).toBe(winner.body.event.description);
    expect(await storedHistory(eventId)).toHaveLength(entries + 1);
    expect(await notificationCount(eventId)).toBe(notifications + 1);
  });

  test("[SPM-33-TC-12] should_deny_the_edit_while_the_event_awaits_clarification", async () => {
    const clarificationEvent = fixtures.events.colleagueSubmitted;
    await setStatus(clarificationEvent, "AWAITING_CLARIFICATION");
    const before = await eventState(clarificationEvent);

    const res = await call("put", `/api/events/${clarificationEvent}`, "coordinator", { description: "Edited meanwhile.", version: before.version }, newKey());

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EVENT_NOT_EDITABLE_IN_STATUS");
    expect(await eventState(clarificationEvent)).toEqual(before);
  });

  test.each(["venueStaff", "techSupport"])(
    "[SPM-33-TC-14] should_leave_the_event_unchanged_when_%s_sends_a_direct_update",
    async (key) => {
      const before = await eventState(eventId);
      const body = { title: "Changed by staff", startDatetime: "2027-06-01T09:00:00+08:00", expectedAttendance: 999 };

      const direct = await call("put", `/api/events/${eventId}`, key, { ...body, version: before.version }, newKey());
      const draftRoute = await call("put", `/api/events/${eventId}/draft`, key, body);

      expect(direct.status).toBe(404);
      expect(direct.body).toEqual({ error: "Event request not found.", code: "EVENT_NOT_FOUND" });
      expect(draftRoute.status).toBe(403);
      expect(await eventState(eventId)).toEqual(before);
    }
  );

  test("[SPM-33-TC-15] should_return_401_and_change_nothing_when_there_is_no_session", async () => {
    const before = await eventState(eventId);

    const res = await request(app).put(`/api/events/${eventId}`).set("Idempotency-Key", newKey()).send({ title: "No session", version: before.version });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
    expect(await eventState(eventId)).toEqual(before);
  });

  test("[SPM-33-TC-20] should_refuse_to_update_or_delete_a_history_entry", async () => {
    const before = await storedHistory(eventId);
    const entry = before[before.length - 1];

    // The backend's own database identity cannot rewrite history...
    const updated = await supabase.from("activity_log").update({ action: "TAMPERED" }).eq("log_id", entry.log_id);
    const deleted = await supabase.from("activity_log").delete().eq("log_id", entry.log_id);
    expect(updated.error).toEqual(expect.objectContaining({ code: "42501" }));
    expect(deleted.error).toEqual(expect.objectContaining({ code: "42501" }));

    // ...and the API offers no route that tries.
    for (const [method, path] of [
      ["put", `/api/events/${eventId}/history/${entry.log_id}`],
      ["delete", `/api/events/${eventId}/history/${entry.log_id}`],
      ["delete", `/api/events/${eventId}/history`],
    ]) {
      const res = await call(method, path, "coordinator", method === "delete" ? undefined : { action: "TAMPERED" });
      expect(res.status).toBe(404);
    }
    expect(await storedHistory(eventId)).toEqual(before);
  });

  test("[SPM-33-CONC-002] should_never_apply_an_edit_after_a_reassignment_that_raced_it", async () => {
    const racedEvent = fixtures.events.soloSubmitted;
    // A separate time window, so the new coordinator has no overlapping event.
    await rows(
      supabase
        .from("event")
        .update({ start_datetime: "2027-04-01T01:00:00Z", end_datetime: "2027-04-01T03:00:00Z" })
        .eq("event_id", racedEvent)
        .like("title", `spm32-${runId}%`)
        .select("event_id"),
      "move raced event"
    );
    const { version } = await loadEvent("coordinator", racedEvent);

    const [edit, reassignment] = await Promise.all([
      call("put", `/api/events/${racedEvent}`, "coordinator", { description: "Raced edit.", version }, newKey()),
      reassign(racedEvent, "coordinator", "coordinator2"),
    ]);

    expect(reassignment.error).toBeNull();
    const after = await eventState(racedEvent);
    expect(after.coordinator_id).toBe(userId("coordinator2"));
    // Either the edit committed first, or it waited for the reassignment and then
    // found the event no longer assigned to this coordinator.
    expect([200, 404]).toContain(edit.status);
    expect(after.description === "Raced edit.").toBe(edit.status === 200);

    const late = await call("put", `/api/events/${racedEvent}`, "coordinator", { description: "After reassignment.", version: after.version }, newKey());
    expect(late.status).toBe(404);
    expect((await eventState(racedEvent)).description).toBe(after.description);
  });

  test("[SPM-33-TC-13] should_remove_edit_and_view_access_as_soon_as_the_coordinator_is_reassigned", async () => {
    const { version } = await loadEvent("coordinator", eventId);
    const reassignment = await reassign(eventId, "coordinator", "coordinator2");
    expect(reassignment.error).toBeNull();
    const before = await eventState(eventId);

    const oldPageSave = await call("put", `/api/events/${eventId}`, "coordinator", { description: "Saved from the old page.", version }, newKey());

    expect(oldPageSave.status).toBe(404);
    expect(oldPageSave.body).toEqual({ error: "Event request not found.", code: "EVENT_NOT_FOUND" });
    expect(await eventState(eventId)).toEqual(before);
    expect((await call("get", `/api/events/${eventId}`, "coordinator")).status).toBe(404);
    expect((await call("get", `/api/events/${eventId}/history`, "coordinator")).status).toBe(404);

    const newCoordinator = await loadEvent("coordinator2", eventId);
    expect(newCoordinator.viewerRelationship).toBe("ASSIGNED_COORDINATOR");
    const saved = await call("put", `/api/events/${eventId}`, "coordinator2", { description: "Saved by the new coordinator.", version: newCoordinator.version }, newKey());
    expect(saved.status).toBe(200);
  });

  // The reassignment reason lives in event_assignments, which the history API
  // never reads, so only the staff-only history entry is checked here.
  test("[SPM-33-TC-19] should_hide_the_reassignment_record_from_the_owner_but_not_the_coordinator", async () => {
    const stored = await storedHistory(eventId);
    expect(stored.filter(({ action }) => action === "COORDINATOR_REASSIGNED")).toEqual([
      expect.objectContaining({ audience: "STAFF_ONLY", actor_role: "COORDINATOR_LEAD", user_id: userId("coordinatorLead") }),
    ]);

    const ownerResponse = await call("get", `/api/events/${eventId}/history?limit=100`, "organiserA");
    const ownerEvent = await call("get", `/api/events/${eventId}`, "organiserA");

    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.body.history.length).toBeGreaterThan(0);
    expect(ownerResponse.body.history.every((entry) => entry.audience === "ORGANISER_SAFE")).toBe(true);
    expect(ownerResponse.body.history.map((entry) => entry.action)).not.toContain("COORDINATOR_REASSIGNED");
    for (const body of [ownerResponse.body, ownerEvent.body]) {
      expect(JSON.stringify(body)).not.toContain("previousCoordinatorId");
    }

    const coordinatorHistory = await historyFor("coordinator2", eventId);
    expect(coordinatorHistory.map((entry) => entry.action)).toContain("COORDINATOR_REASSIGNED");
    expect(coordinatorHistory.length).toBe(stored.filter(({ audience }) => audience !== "OWNER_ONLY").length);
  });
});
