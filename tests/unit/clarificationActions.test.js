// SPM-41 route-level unit tests for the clarification thread actions: opening a
// thread, posting messages, saving amendments, completing the thread, marking it
// read and marking the history viewed. Real Express app, routes, middleware,
// access policy and validation; only Supabase-facing model functions are mocked.
// The database rules (threads, rollback, replay, notification throttle) are
// covered by tests/integration/clarifications.integration.test.js.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/activityModel", () => {
  const actual = jest.requireActual("../../model/activityModel");
  return {
    ...actual,
    findEventHistory: jest.fn(),
    findLastHistoryView: jest.fn(),
    markEventHistoryViewed: jest.fn(),
  };
});
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return {
    ...actual,
    findVisibleEvent: jest.fn(),
    findEventClarifications: jest.fn(),
    findValidationContext: jest.fn(),
    requestClarification: jest.fn(),
    postClarificationMessage: jest.fn(),
    saveClarificationAmendments: jest.fn(),
    completeClarification: jest.fn(),
    markClarificationRead: jest.fn(),
    runLifecycleAction: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const activityModel = require("../../model/activityModel");

const {
  toEventRequestError,
  requestClarification: realRequestClarification,
  postClarificationMessage: realPostClarificationMessage,
  saveClarificationAmendments: realSaveClarificationAmendments,
  completeClarification: realCompleteClarification,
  markClarificationRead: realMarkClarificationRead,
} = jest.requireActual("../../model/eventModel");

const ORGANISER_ID = 11;
const COLLEAGUE_ID = 12;
const COORDINATOR_ID = 21;
const OTHER_COORDINATOR_ID = 22;
const ORGANISATION_ID = 5;
const KEY = "5f0f2a7c-1d7e-4c8e-9a51-6b2f1c3d4e5f";
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY).toISOString();

const eventRow = (overrides = {}) => ({
  event_id: 42,
  organiser_id: ORGANISER_ID,
  organisation_id: ORGANISATION_ID,
  coordinator_id: COORDINATOR_ID,
  status: "UNDER_REVIEW",
  title: "SMU Alumni Gala 2026",
  purpose: "Reconnect alumni.",
  description: "An evening for alumni.",
  start_datetime: inDays(20),
  end_datetime: new Date(Date.now() + 20 * DAY + 3 * 60 * 60 * 1000).toISOString(),
  expected_attendance: 120,
  preferred_layout_type: "Banquet",
  accessibility_needs: null,
  is_registration_enabled: false,
  registration_capacity: null,
  version: 4,
  arrangement_version: 1,
  event_venue_preference: [],
  event_equipment_requirement: [],
  updated_at: "2026-10-20T02:00:00+00:00",
  ...overrides,
});

const awaiting = (overrides = {}) => eventRow({ status: "AWAITING_CLARIFICATION", ...overrides });

const QUESTION = "Please confirm the stage size.";

const thread = (overrides = {}) => ({
  clarificationId: 8,
  round: 1,
  status: "OPEN",
  message: QUESTION,
  requestedAt: "2026-10-20T02:00:00+00:00",
  requestedBy: { userId: COORDINATOR_ID, name: "Coordinator C" },
  completedAt: null,
  completedBy: null,
  messages: [
    {
      messageId: 30,
      body: QUESTION,
      createdAt: "2026-10-20T02:00:00+00:00",
      author: { userId: COORDINATOR_ID, name: "Coordinator C", role: "COORDINATOR" },
    },
  ],
  unreadCount: 0,
  ...overrides,
});

const domainError = (code, extra = {}) => Object.assign(new Error(code), { name: "EventRequestError", code, ...extra });

const signedInAs = (role, userId, organisationIds = []) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: organisationIds });
};

const post = (path, body, headers = { "Idempotency-Key": KEY }) => {
  let req = request(app).post(path).set("Authorization", "Bearer token");
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  eventModel.findValidationContext.mockResolvedValue({ allowedLayouts: ["NO_PREFERENCE", "Banquet", "Theatre"], venueIds: [3, 4], equipmentIds: [7] });
  eventModel.findEventClarifications.mockResolvedValue([thread()]);
});

describe("POST /api/events/:id/clarifications (SPM-41 AC1)", () => {
  beforeEach(() => {
    signedInAs("COORDINATOR", COORDINATOR_ID);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow());
  });

  test("[SPM-41-TC-01] should_return_the_event_with_the_new_thread_when_the_assigned_coordinator_requests_clarification", async () => {
    eventModel.requestClarification.mockResolvedValue({ clarificationId: 8, replayed: false });
    eventModel.findVisibleEvent
      .mockResolvedValueOnce(eventRow())
      .mockResolvedValueOnce(awaiting({ version: 5 }));

    const res = await post("/api/events/42/clarifications", { message: `  ${QUESTION}  `, version: 4 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Clarification requested. The organiser has been notified.");
    expect(res.body.event).toEqual(expect.objectContaining({ eventId: 42, status: "AWAITING_CLARIFICATION", version: 5 }));
    expect(res.body.event.permissions).toEqual(expect.objectContaining({
      canRequestClarification: false,
      canPostClarificationMessage: true,
      canCompleteClarification: true,
      canSaveAmendments: false,
    }));
    expect(res.body.clarification).toEqual(thread());
    expect(eventModel.requestClarification).toHaveBeenCalledWith({
      eventId: 42,
      actorId: COORDINATOR_ID,
      message: QUESTION,
      expectedVersion: 4,
      idempotencyKey: KEY,
    });
    expect(eventModel.findEventClarifications).toHaveBeenCalledWith(42, { readerId: COORDINATOR_ID });
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
  });

  test.each([
    ["missing", {}],
    ["blank", { message: "   " }],
    ["not text", { message: 12 }],
  ])("[SPM-41-TC-02] should_refuse_a_%s_message_without_changing_the_event", async (_label, body) => {
    const res = await post("/api/events/42/clarifications", { ...body, version: 4 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.fields).toHaveProperty("message");
    expect(eventModel.requestClarification).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC1] should_refuse_a_message_longer_than_2000_characters", async () => {
    const res = await post("/api/events/42/clarifications", { message: "x".repeat(2001), version: 4 });

    expect(res.status).toBe(400);
    expect(res.body.fields.message).toBe("Keep this to 2000 characters or fewer.");
    expect(eventModel.requestClarification).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC1] should_accept_a_message_of_exactly_2000_characters", async () => {
    eventModel.requestClarification.mockResolvedValue({ clarificationId: 8, replayed: false });

    const res = await post("/api/events/42/clarifications", { message: "x".repeat(2000), version: 4 });

    expect(res.status).toBe(200);
  });

  test("[SPM-41-AC1] should_require_the_loaded_version_and_an_idempotency_key", async () => {
    const res = await post("/api/events/42/clarifications", { message: "Question?" }, {});

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(expect.objectContaining({ version: expect.any(String), idempotencyKey: expect.any(String) }));
    expect(eventModel.requestClarification).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC1] should_refuse_fields_other_than_the_message", async () => {
    const res = await post("/api/events/42/clarifications", { message: "Question?", version: 4, status: "PLANNING" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("status");
  });

  test("[SPM-41-AC1] should_answer_404_when_another_coordinator_requests_clarification", async () => {
    signedInAs("COORDINATOR", OTHER_COORDINATOR_ID);

    const res = await post("/api/events/42/clarifications", { message: "Question?", version: 4 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
    expect(eventModel.requestClarification).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC1] should_answer_403_when_an_organiser_requests_clarification", async () => {
    signedInAs("ORGANISER", ORGANISER_ID);

    const res = await post("/api/events/42/clarifications", { message: "Question?", version: 4 });

    expect(res.status).toBe(403);
    expect(eventModel.requestClarification).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC1] should_answer_403_naming_the_status_when_the_event_is_not_under_review", async () => {
    eventModel.requestClarification.mockRejectedValue(domainError("TRANSITION_NOT_ALLOWED", { currentStatus: "PLANNING" }));

    const res = await post("/api/events/42/clarifications", { message: "Question?", version: 4 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ code: "TRANSITION_NOT_ALLOWED", currentStatus: "PLANNING" }));
  });

  test("[SPM-41-AC1] should_answer_409_with_the_current_event_when_the_version_is_stale", async () => {
    eventModel.requestClarification.mockRejectedValue(domainError("EVENT_VERSION_CONFLICT", { currentStatus: "UNDER_REVIEW" }));
    eventModel.findVisibleEvent.mockResolvedValueOnce(eventRow()).mockResolvedValueOnce(eventRow({ version: 6 }));

    const res = await post("/api/events/42/clarifications", { message: "Question?", version: 4 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_VERSION_CONFLICT");
    expect(res.body.event).toEqual(expect.objectContaining({ eventId: 42, version: 6 }));
  });

  test("[SPM-41-AC1] should_mark_a_replayed_request", async () => {
    eventModel.requestClarification.mockResolvedValue({ clarificationId: 8, replayed: true });

    const res = await post("/api/events/42/clarifications", { message: "Question?", version: 4 });

    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });
});

describe("POST /api/events/:id/clarifications/:round/messages (SPM-41 v2)", () => {
  const reply = "The stage is 6m wide.";
  const withReply = (authorId, role) =>
    thread({
      messages: [
        ...thread().messages,
        { messageId: 31, body: reply, createdAt: "2026-10-21T02:00:00+00:00", author: { userId: authorId, name: "Someone", role } },
      ],
    });

  beforeEach(() => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    eventModel.findVisibleEvent.mockResolvedValue(awaiting());
    eventModel.postClarificationMessage.mockResolvedValue({ messageId: 31, replayed: false });
  });

  test("[SPM-41-AC3] should_add_the_owners_message_and_return_the_thread", async () => {
    eventModel.findEventClarifications.mockResolvedValue([withReply(ORGANISER_ID, "ORGANISER")]);

    const res = await post("/api/events/42/clarifications/1/messages", { body: `  ${reply}  ` });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: "Message sent.", clarification: withReply(ORGANISER_ID, "ORGANISER") });
    expect(eventModel.postClarificationMessage).toHaveBeenCalledWith({
      eventId: 42,
      round: 1,
      actorId: ORGANISER_ID,
      body: reply,
      idempotencyKey: KEY,
    });
    expect(eventModel.findEventClarifications).toHaveBeenCalledWith(42, { readerId: ORGANISER_ID });
  });

  test("[SPM-41-AC3] should_add_the_assigned_coordinators_message", async () => {
    signedInAs("COORDINATOR", COORDINATOR_ID);

    const res = await post("/api/events/42/clarifications/1/messages", { body: "Thanks, one more question." });

    expect(res.status).toBe(201);
    expect(eventModel.postClarificationMessage).toHaveBeenCalledWith(expect.objectContaining({ actorId: COORDINATOR_ID }));
  });

  test("[SPM-41-AC3] should_answer_403_when_a_same_organisation_organiser_writes_in_the_thread", async () => {
    signedInAs("ORGANISER", COLLEAGUE_ID, [ORGANISATION_ID]);

    const res = await post("/api/events/42/clarifications/1/messages", { body: "Answering for them." });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EVENT_READ_ONLY");
    expect(eventModel.postClarificationMessage).not.toHaveBeenCalled();
  });

  test.each([
    ["a coordinator who is not assigned", "COORDINATOR", OTHER_COORDINATOR_ID, []],
    ["an organiser from another organisation", "ORGANISER", 13, [77]],
    ["an attendee", "ATTENDEE", 51, []],
  ])("[SPM-41-AC3] should_answer_404_without_writing_for_%s", async (_label, role, userId, organisationIds) => {
    signedInAs(role, userId, organisationIds);

    const res = await post("/api/events/42/clarifications/1/messages", { body: "Hello." });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
    expect(eventModel.postClarificationMessage).not.toHaveBeenCalled();
  });

  test.each([
    ["missing", {}],
    ["blank", { body: "   " }],
    ["not text", { body: 7 }],
  ])("[SPM-41-AC3] should_refuse_a_%s_message", async (_label, body) => {
    const res = await post("/api/events/42/clarifications/1/messages", body);

    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("body");
    expect(eventModel.postClarificationMessage).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_accept_2000_characters_and_refuse_2001", async () => {
    const accepted = await post("/api/events/42/clarifications/1/messages", { body: "x".repeat(2000) });
    const refused = await post("/api/events/42/clarifications/1/messages", { body: "x".repeat(2001) });

    expect(accepted.status).toBe(201);
    expect(refused.status).toBe(400);
    expect(refused.body.fields.body).toBe("Keep this to 2000 characters or fewer.");
  });

  test("[SPM-41-AC3] should_require_an_idempotency_key_and_refuse_other_fields", async () => {
    const noKey = await post("/api/events/42/clarifications/1/messages", { body: "Hello." }, {});
    const extra = await post("/api/events/42/clarifications/1/messages", { body: "Hello.", version: 4 });

    expect(noKey.status).toBe(400);
    expect(noKey.body.fields).toHaveProperty("idempotencyKey");
    expect(extra.status).toBe(400);
    expect(extra.body.fields).toHaveProperty("version");
    expect(eventModel.postClarificationMessage).not.toHaveBeenCalled();
  });

  test.each(["0", "abc", "1.5"])("[SPM-41-AC3] should_answer_404_for_the_thread_number_%s", async (round) => {
    const res = await post(`/api/events/42/clarifications/${round}/messages`, { body: "Hello." });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CLARIFICATION_NOT_FOUND");
    expect(eventModel.postClarificationMessage).not.toHaveBeenCalled();
  });

  test.each([
    ["CLARIFICATION_NOT_FOUND", 404],
    ["CLARIFICATION_CLOSED", 409],
  ])("[SPM-41-AC3] should_answer_%s_from_the_database_with_%i", async (code, status) => {
    eventModel.postClarificationMessage.mockRejectedValue(domainError(code));

    const res = await post("/api/events/42/clarifications/1/messages", { body: "Hello." });

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  test("[SPM-41-AC3] should_mark_a_replayed_message", async () => {
    eventModel.postClarificationMessage.mockResolvedValue({ messageId: 31, replayed: true });

    const res = await post("/api/events/42/clarifications/1/messages", { body: "Hello." });

    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });
});

describe("POST /api/events/:id/amendments (SPM-41 v2 AC3)", () => {
  beforeEach(() => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    eventModel.findVisibleEvent.mockResolvedValue(awaiting());
    eventModel.saveClarificationAmendments.mockResolvedValue({ replayed: false });
  });

  test("[SPM-41-TC-04] should_save_amendments_and_keep_the_event_returned", async () => {
    eventModel.findVisibleEvent.mockResolvedValueOnce(awaiting()).mockResolvedValueOnce(awaiting({ version: 5, expected_attendance: 150 }));

    const res = await post("/api/events/42/amendments", { changes: { expectedAttendance: 150, venuePreferences: [4, 3] }, version: 4 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Amendments saved. Your coordinator can see what changed.");
    expect(res.body.event).toEqual(expect.objectContaining({ statusLabel: expect.any(String), version: 5, expectedAttendance: 150 }));
    expect(res.body.event.permissions).toEqual(expect.objectContaining({ canSaveAmendments: true, canPostClarificationMessage: true }));
    expect(eventModel.saveClarificationAmendments).toHaveBeenCalledWith({
      eventId: 42,
      actorId: ORGANISER_ID,
      input: { expectedAttendance: 150, venuePreferences: [4, 3] },
      expectedVersion: 4,
      idempotencyKey: KEY,
    });
  });

  test("[SPM-52-AC9] should_keep_equipment_the_event_already_requests_when_judging_amendments", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(awaiting({ event_equipment_requirement: [{ equipment_id: 9, quantity_requested: 2 }] }));

    await post("/api/events/42/amendments", { changes: { expectedAttendance: 150 }, version: 4 });

    // Item 9 may have been deactivated since it was requested; it stays valid.
    expect(eventModel.findValidationContext).toHaveBeenCalledWith(expect.objectContaining({ expectedAttendance: 150 }), [9]);
  });

  test.each([
    ["no changes", { version: 4 }],
    ["an empty change list", { changes: {}, version: 4 }],
  ])("[SPM-41-AC3] should_refuse_%s", async (_label, body) => {
    const res = await post("/api/events/42/amendments", body);

    expect(res.status).toBe(400);
    expect(res.body.fields.changes).toBe("Change at least one detail before saving.");
    expect(eventModel.saveClarificationAmendments).not.toHaveBeenCalled();
  });

  test.each([
    ["registration settings", { isRegistrationEnabled: true }, "isRegistrationEnabled"],
    ["the organisation", { organisationId: 9 }, "organisationId"],
    ["the status", { status: "PLANNING" }, "status"],
  ])("[SPM-41-AC3] should_answer_403_when_the_owner_amends_%s", async (_label, changes, field) => {
    const res = await post("/api/events/42/amendments", { changes, version: 4 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FIELD_NOT_EDITABLE");
    expect(res.body.fields).toHaveProperty(field);
    expect(eventModel.saveClarificationAmendments).not.toHaveBeenCalled();
  });

  test("[SPM-35] should_judge_the_registration_window_only_when_it_is_amended", async () => {
    // Registration enabled, saved before SPM-35 without a window.
    eventModel.findVisibleEvent.mockResolvedValue(awaiting({ is_registration_enabled: true, registration_capacity: 50 }));
    const changes = { registrationOpenAt: inDays(2), registrationCloseAt: inDays(10) };

    const untouched = await post("/api/events/42/amendments", { changes: { title: "Alumni Gala" }, version: 4 });
    const amended = await post("/api/events/42/amendments", { changes, version: 4 });
    const halfAmended = await post("/api/events/42/amendments", { changes: { registrationCloseAt: inDays(10) }, version: 4 });

    expect(untouched.status).toBe(200);
    expect(amended.status).toBe(200);
    expect(eventModel.saveClarificationAmendments).toHaveBeenLastCalledWith(expect.objectContaining({ input: changes }));
    expect(halfAmended.status).toBe(400);
    expect(halfAmended.body.fields.registrationOpenAt).toBe("Registration open date and time is required when registration is enabled.");
  });

  test("[SPM-41-AC3] should_answer_400_for_an_unknown_change_or_body_field_including_the_v1_response", async () => {
    const res = await post("/api/events/42/amendments", { changes: { colour: "red" }, version: 4 });
    const response = await post("/api/events/42/amendments", { response: "Done.", changes: { title: "Gala" }, version: 4 });

    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("colour");
    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty("response");
  });

  test("[SPM-41-AC3] should_refuse_amendments_that_leave_an_incomplete_or_inconsistent_request", async () => {
    const blank = await post("/api/events/42/amendments", { changes: { purpose: " " }, version: 4 });
    const order = await post("/api/events/42/amendments", { changes: { endDatetime: inDays(19) }, version: 4 });

    expect(blank.status).toBe(400);
    expect(blank.body.fields).toHaveProperty("purpose");
    expect(order.status).toBe(400);
    expect(order.body.fields.endDatetime).toBe("End time must be after start time.");
    expect(eventModel.saveClarificationAmendments).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_apply_the_48_hour_lead_time_only_to_an_amended_start", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(awaiting({ start_datetime: inDays(1), end_datetime: inDays(1.1) }));

    const unchanged = await post("/api/events/42/amendments", { changes: { title: "Alumni Gala" }, version: 4 });
    const amended = await post("/api/events/42/amendments", { changes: { startDatetime: inDays(1.05) }, version: 4 });

    expect(unchanged.status).toBe(200);
    expect(amended.status).toBe(400);
    expect(amended.body.fields.startDatetime).toBe("Event date must be at least 48 hours in advance.");
  });

  test("[SPM-41-AC3] should_answer_403_when_a_same_organisation_organiser_amends", async () => {
    signedInAs("ORGANISER", COLLEAGUE_ID, [ORGANISATION_ID]);

    const res = await post("/api/events/42/amendments", { changes: { title: "Gala" }, version: 4 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EVENT_READ_ONLY");
    expect(eventModel.saveClarificationAmendments).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_403_when_a_coordinator_amends", async () => {
    signedInAs("COORDINATOR", COORDINATOR_ID);

    const res = await post("/api/events/42/amendments", { changes: { title: "Gala" }, version: 4 });

    expect(res.status).toBe(403);
    expect(eventModel.saveClarificationAmendments).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_409_with_the_current_event_when_the_version_is_stale", async () => {
    eventModel.saveClarificationAmendments.mockRejectedValue(domainError("EVENT_VERSION_CONFLICT"));
    eventModel.findVisibleEvent.mockResolvedValueOnce(awaiting()).mockResolvedValueOnce(awaiting({ version: 5 }));

    const res = await post("/api/events/42/amendments", { changes: { title: "Gala" }, version: 4 });

    expect(res.status).toBe(409);
    expect(res.body.event).toEqual(expect.objectContaining({ version: 5 }));
  });

  test("[SPM-41-AC3] should_explain_a_coordinator_schedule_clash_in_amendment_terms", async () => {
    eventModel.saveClarificationAmendments.mockRejectedValue(domainError("COORDINATOR_CONFLICT"));

    const res = await post("/api/events/42/amendments", { changes: { startDatetime: inDays(25), endDatetime: inDays(25.1) }, version: 4 });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "COORDINATOR_CONFLICT",
      error: "The new dates clash with your coordinator's schedule. Choose different dates or contact your coordinator.",
    });
  });

  test.each([
    ["CLARIFICATION_NOT_OPEN", 409, {}],
    ["TRANSITION_NOT_ALLOWED", 403, { currentStatus: "UNDER_REVIEW" }],
  ])("[SPM-41-AC3] should_answer_%s_with_%i", async (code, status, extra) => {
    eventModel.saveClarificationAmendments.mockRejectedValue(domainError(code, extra));

    const res = await post("/api/events/42/amendments", { changes: { title: "Gala" }, version: 4 });

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  test("[SPM-41-AC3] should_no_longer_offer_the_v1_resubmit_route", async () => {
    const res = await post("/api/events/42/resubmit", { response: "Done.", version: 4 });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/events/:id/clarifications/:round/complete (SPM-41 v2)", () => {
  beforeEach(() => {
    signedInAs("COORDINATOR", COORDINATOR_ID);
    eventModel.findVisibleEvent.mockResolvedValue(awaiting());
    eventModel.completeClarification.mockResolvedValue({ clarificationId: 8, replayed: false });
  });

  test("[SPM-41-TC-04] should_complete_the_thread_and_return_the_event_to_review", async () => {
    const completed = thread({ status: "COMPLETED", completedAt: "2026-10-22T02:00:00+00:00", completedBy: { userId: COORDINATOR_ID, name: "Coordinator C" } });
    eventModel.findEventClarifications.mockResolvedValue([completed]);
    eventModel.findVisibleEvent.mockResolvedValueOnce(awaiting()).mockResolvedValueOnce(eventRow({ version: 6 }));

    const res = await post("/api/events/42/clarifications/1/complete", { version: 5 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Clarification marked complete. The request is back under review.");
    expect(res.body.event).toEqual(expect.objectContaining({ status: "UNDER_REVIEW", version: 6 }));
    expect(res.body.event.permissions).toEqual(expect.objectContaining({ canCompleteClarification: false, canRequestClarification: true }));
    expect(res.body.clarification).toEqual(completed);
    expect(eventModel.completeClarification).toHaveBeenCalledWith({
      eventId: 42,
      round: 1,
      actorId: COORDINATOR_ID,
      expectedVersion: 5,
      idempotencyKey: KEY,
    });
  });

  test("[SPM-41-AC3] should_require_the_loaded_version_and_an_idempotency_key", async () => {
    const res = await post("/api/events/42/clarifications/1/complete", {}, {});

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(expect.objectContaining({ version: expect.any(String), idempotencyKey: expect.any(String) }));
    expect(eventModel.completeClarification).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_403_when_the_owner_completes_the_thread", async () => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);

    const res = await post("/api/events/42/clarifications/1/complete", { version: 5 });

    expect(res.status).toBe(403);
    expect(eventModel.completeClarification).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_404_when_another_coordinator_completes_the_thread", async () => {
    signedInAs("COORDINATOR", OTHER_COORDINATOR_ID);

    const res = await post("/api/events/42/clarifications/1/complete", { version: 5 });

    expect(res.status).toBe(404);
    expect(eventModel.completeClarification).not.toHaveBeenCalled();
  });

  test.each([
    ["CLARIFICATION_NOT_FOUND", 404, {}],
    ["CLARIFICATION_CLOSED", 409, {}],
    ["TRANSITION_NOT_ALLOWED", 403, { currentStatus: "UNDER_REVIEW" }],
  ])("[SPM-41-AC3] should_answer_%s_with_%i", async (code, status, extra) => {
    eventModel.completeClarification.mockRejectedValue(domainError(code, extra));

    const res = await post("/api/events/42/clarifications/1/complete", { version: 5 });

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  test("[SPM-41-AC3] should_answer_409_with_the_current_event_when_amendments_arrived_after_loading", async () => {
    eventModel.completeClarification.mockRejectedValue(domainError("EVENT_VERSION_CONFLICT"));
    eventModel.findVisibleEvent.mockResolvedValueOnce(awaiting()).mockResolvedValueOnce(awaiting({ version: 7 }));

    const res = await post("/api/events/42/clarifications/1/complete", { version: 5 });

    expect(res.status).toBe(409);
    expect(res.body.event).toEqual(expect.objectContaining({ version: 7 }));
  });

  test("[SPM-41-AC3] should_answer_404_for_a_thread_number_that_is_not_a_number", async () => {
    const res = await post("/api/events/42/clarifications/x/complete", { version: 5 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CLARIFICATION_NOT_FOUND");
  });
});

describe("marking threads read and history viewed (SPM-41 v2)", () => {
  beforeEach(() => {
    eventModel.findVisibleEvent.mockResolvedValue(awaiting());
  });

  test.each([
    ["the owner", "ORGANISER", ORGANISER_ID],
    ["the assigned coordinator", "COORDINATOR", COORDINATOR_ID],
  ])("[SPM-41] acknowledges the displayed cursor for %s", async (_label, role, userId) => {
    signedInAs(role, userId, [ORGANISATION_ID]);
    eventModel.markClarificationRead.mockResolvedValue(true);
    const res = await post("/api/events/42/clarifications/1/read", { lastMessageId: 30 }, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ read: true });
    expect(eventModel.markClarificationRead).toHaveBeenCalledWith({ eventId: 42, round: 1, actorId: userId, lastMessageId: 30 });
  });

  test("[SPM-41] colleagues and legacy clients cannot acknowledge unseen messages", async () => {
    signedInAs("ORGANISER", COLLEAGUE_ID, [ORGANISATION_ID]);
    const colleague = await post("/api/events/42/clarifications/1/read", { lastMessageId: 30 }, {});
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    const legacy = await post("/api/events/42/clarifications/1/read", undefined, {});
    expect(colleague.body).toEqual({ read: false });
    expect(legacy.body).toEqual({ read: false });
    expect(eventModel.markClarificationRead).not.toHaveBeenCalled();
  });

  test.each([-1, 1.5, "30", null, 2147483648])("[SPM-41] invalid displayed cursor %p is refused", async (lastMessageId) => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    const res = await post("/api/events/42/clarifications/1/read", { lastMessageId }, {});
    expect(res.status).toBe(400);
    expect(eventModel.markClarificationRead).not.toHaveBeenCalled();
  });

  test("[SPM-41] newer replies prevent acknowledgement without claiming success", async () => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    eventModel.markClarificationRead.mockResolvedValue(false);
    const res = await post("/api/events/42/clarifications/1/read", { lastMessageId: 30 }, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ read: false });
  });

  test("[SPM-41 security] Safety Officers cannot acknowledge clarification reads", async () => {
    signedInAs("SAFETY_OFFICER", 31);
    eventModel.findVisibleEvent.mockResolvedValue(awaiting({ safety_reviews: [{ status: "OPEN", claimed_by: null }] }));
    const res = await post("/api/events/42/clarifications/1/read", { lastMessageId: 30 }, {});
    expect(res.status).toBe(404);
    expect(eventModel.markClarificationRead).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_404_without_recording_a_read_outside_the_viewing_scope", async () => {
    signedInAs("COORDINATOR", OTHER_COORDINATOR_ID);

    const res = await post("/api/events/42/clarifications/1/read", undefined, {});

    expect(res.status).toBe(404);
    expect(eventModel.markClarificationRead).not.toHaveBeenCalled();
  });

  test.each([
    ["the owner", "ORGANISER", ORGANISER_ID],
    ["a same-organisation organiser", "ORGANISER", COLLEAGUE_ID],
    ["the assigned coordinator", "COORDINATOR", COORDINATOR_ID],
  ])("[SPM-41-AC5] should_record_when_%s_viewed_the_history", async (_label, role, userId) => {
    signedInAs(role, userId, [ORGANISATION_ID]);
    activityModel.markEventHistoryViewed.mockResolvedValue("2026-10-24T03:00:00+00:00");

    const res = await post("/api/events/42/history/viewed", undefined, {});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ lastViewedAt: "2026-10-24T03:00:00+00:00" });
    expect(activityModel.markEventHistoryViewed).toHaveBeenCalledWith(42, userId);
  });

  test.each([
    ["a coordinator who is not assigned", "COORDINATOR", OTHER_COORDINATOR_ID, []],
    ["an organiser from another organisation", "ORGANISER", 13, [77]],
  ])("[SPM-41-AC5] should_answer_404_without_recording_a_history_view_for_%s", async (_label, role, userId, organisationIds) => {
    signedInAs(role, userId, organisationIds);

    const res = await post("/api/events/42/history/viewed", undefined, {});

    expect(res.status).toBe(404);
    expect(activityModel.markEventHistoryViewed).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC5] should_return_when_this_viewer_last_viewed_the_history", async () => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    activityModel.findEventHistory.mockResolvedValue({ history: [], nextCursor: null });
    activityModel.findLastHistoryView.mockResolvedValue("2026-10-23T03:00:00+00:00");

    const res = await request(app).get("/api/events/42/history").set("Authorization", "Bearer token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ history: [], nextCursor: null, lastViewedAt: "2026-10-23T03:00:00+00:00" });
    expect(activityModel.findLastHistoryView).toHaveBeenCalledWith(42, ORGANISER_ID);
  });
});

describe("SPM-41 TC-03: planning stays blocked while the event is returned", () => {
  test("[SPM-41-TC-03] should_refuse_planning_actions_and_direct_edits_in_AWAITING_CLARIFICATION", async () => {
    signedInAs("COORDINATOR", COORDINATOR_ID);
    eventModel.findVisibleEvent.mockResolvedValue(awaiting());
    eventModel.runLifecycleAction.mockRejectedValue(domainError("TRANSITION_NOT_ALLOWED", { currentStatus: "AWAITING_CLARIFICATION" }));

    const action = await post("/api/events/42/submit-for-safety-review", { version: 4 });
    const edit = await request(app)
      .put("/api/events/42")
      .set("Authorization", "Bearer token")
      .set("Idempotency-Key", KEY)
      .send({ title: "New title", version: 4 });

    expect(action.status).toBe(403);
    expect(action.body.currentStatus).toBe("AWAITING_CLARIFICATION");
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe("EVENT_NOT_EDITABLE_IN_STATUS");
  });
});

describe("SPM-41 permission flags in GET /api/events/:id", () => {
  const none = { canRequestClarification: false, canPostClarificationMessage: false, canSaveAmendments: false, canCompleteClarification: false };

  test.each([
    ["the assigned coordinator, under review", "COORDINATOR", COORDINATOR_ID, "UNDER_REVIEW", { ...none, canRequestClarification: true }],
    ["the assigned coordinator, returned", "COORDINATOR", COORDINATOR_ID, "AWAITING_CLARIFICATION", { ...none, canPostClarificationMessage: true, canCompleteClarification: true }],
    ["the owner, returned", "ORGANISER", ORGANISER_ID, "AWAITING_CLARIFICATION", { ...none, canPostClarificationMessage: true, canSaveAmendments: true }],
    ["the owner, under review", "ORGANISER", ORGANISER_ID, "UNDER_REVIEW", none],
    ["a same-organisation organiser, returned", "ORGANISER", COLLEAGUE_ID, "AWAITING_CLARIFICATION", none],
  ])("[SPM-41-AC3] should_grant_the_right_flags_to_%s", async (_label, role, userId, status, flags) => {
    signedInAs(role, userId, [ORGANISATION_ID]);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status }));

    const res = await request(app).get("/api/events/42").set("Authorization", "Bearer token");

    expect(res.status).toBe(200);
    expect(res.body.event.permissions).toEqual(expect.objectContaining(flags));
    expect(res.body.event.permissions).not.toHaveProperty("canResubmit");
  });
});

describe("SPM-41 model mapping", () => {
  const rpcReturns = (data) => supabase.rpc.mockResolvedValue({ data, error: null });

  test("[SPM-41-AC1] should_call_the_request_function_with_a_request_hash_and_return_the_thread_id", async () => {
    rpcReturns({ event: { event_id: 42 }, clarification: { clarification_id: 8 }, replayed: false });

    const result = await realRequestClarification({ eventId: 42, actorId: COORDINATOR_ID, message: "Question?", expectedVersion: 4, idempotencyKey: KEY });

    expect(result).toEqual({ clarificationId: 8, replayed: false });
    expect(supabase.rpc).toHaveBeenCalledWith("request_event_clarification", expect.objectContaining({
      p_event_id: 42,
      p_actor_id: COORDINATOR_ID,
      p_expected_version: 4,
      p_message: "Question?",
      p_idempotency_key: KEY,
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  test("[SPM-41-AC3] should_post_a_message_by_thread_number_and_return_its_id", async () => {
    rpcReturns({ message: { message_id: 31 }, replayed: true });

    const result = await realPostClarificationMessage({ eventId: 42, round: 2, actorId: ORGANISER_ID, body: "Hello.", idempotencyKey: KEY });

    expect(result).toEqual({ messageId: 31, replayed: true });
    expect(supabase.rpc).toHaveBeenCalledWith("post_clarification_message", expect.objectContaining({
      p_event_id: 42,
      p_round_number: 2,
      p_actor_id: ORGANISER_ID,
      p_body: "Hello.",
      p_idempotency_key: KEY,
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  test("[SPM-41-AC3] should_send_amendments_as_columns_and_requirements_separately", async () => {
    rpcReturns({ event: { event_id: 42 }, replayed: false });

    const result = await realSaveClarificationAmendments({
      eventId: 42,
      actorId: ORGANISER_ID,
      input: { expectedAttendance: 150, venuePreferences: [4, 3] },
      expectedVersion: 4,
      idempotencyKey: KEY,
    });

    expect(result).toEqual({ replayed: false });
    expect(supabase.rpc).toHaveBeenCalledWith("save_clarification_amendments", expect.objectContaining({
      p_event_id: 42,
      p_actor_id: ORGANISER_ID,
      p_expected_version: 4,
      p_changes: { expected_attendance: 150 },
      p_venue_preferences: [4, 3],
      p_equipment_requirements: null,
    }));
  });

  test("[SPM-41-AC3] should_complete_a_thread_by_number_with_the_loaded_version", async () => {
    rpcReturns({ event: { event_id: 42 }, clarification: { clarification_id: 8 }, replayed: false });

    const result = await realCompleteClarification({ eventId: 42, round: 1, actorId: COORDINATOR_ID, expectedVersion: 5, idempotencyKey: KEY });

    expect(result).toEqual({ clarificationId: 8, replayed: false });
    expect(supabase.rpc).toHaveBeenCalledWith("complete_event_clarification", expect.objectContaining({
      p_event_id: 42,
      p_round_number: 1,
      p_actor_id: COORDINATOR_ID,
      p_expected_version: 5,
    }));
  });

  test("[SPM-41-AC3] should_mark_a_thread_read_and_surface_a_database_failure", async () => {
    supabase.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(realMarkClarificationRead({ eventId: 42, round: 1, actorId: ORGANISER_ID, lastMessageId: 30 })).resolves.toBe(true);
    expect(supabase.rpc).toHaveBeenCalledWith("mark_clarification_read", { p_event_id: 42, p_round_number: 1, p_actor_id: ORGANISER_ID, p_last_message_id: 30 });

    supabase.rpc.mockResolvedValueOnce({ data: null, error: { message: "permission denied" } });
    await expect(realMarkClarificationRead({ eventId: 42, round: 1, actorId: ORGANISER_ID })).rejects.toThrow("permission denied");
  });

  test("[SPM-41-AC3] should_refuse_an_incomplete_function_result", async () => {
    rpcReturns({ replayed: false });

    await expect(realPostClarificationMessage({ eventId: 42, round: 1, actorId: ORGANISER_ID, body: "Hi.", idempotencyKey: KEY }))
      .rejects.toThrow("post_clarification_message returned an incomplete result.");
  });

  test.each([
    [{ message: "AMENDMENT_EMPTY" }, { changes: "Change at least one detail before saving." }],
    [{ message: "INVALID_CLARIFICATION", details: "message:TOO_LONG" }, { message: "Keep this to 2000 characters or fewer." }],
    [{ message: "INVALID_CLARIFICATION", details: "message:REQUIRED" }, { message: "Enter the question for the organiser." }],
    [{ message: "INVALID_CLARIFICATION", details: "body:REQUIRED" }, { body: "Write a message before sending." }],
    [{ message: "INVALID_CLARIFICATION", details: "body:TOO_LONG" }, { body: "Keep this to 2000 characters or fewer." }],
  ])("[SPM-41-AC3] should_report_database_validation_as_field_errors (%o)", (error, fields) => {
    expect(toEventRequestError(error)).toEqual(expect.objectContaining({ code: "VALIDATION_FAILED", fields }));
  });

  test.each(["CLARIFICATION_NOT_OPEN", "CLARIFICATION_NOT_FOUND", "CLARIFICATION_CLOSED"])(
    "[SPM-41-AC3] should_report_%s_as_its_own_code",
    (code) => {
      expect(toEventRequestError({ message: code })).toEqual(expect.objectContaining({ code }));
    }
  );
});
