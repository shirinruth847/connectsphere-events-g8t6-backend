// SPM-41 route-level unit tests for POST /api/events/:id/clarifications and
// /resubmit: real Express app, routes, middleware, access policy and validation.
// Only Supabase-facing model functions are mocked; the database rules (rounds,
// rollback, replay, notifications) are covered by
// tests/integration/clarifications.integration.test.js.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return {
    ...actual,
    findVisibleEvent: jest.fn(),
    findEventClarifications: jest.fn(),
    findValidationContext: jest.fn(),
    requestClarification: jest.fn(),
    resubmitEvent: jest.fn(),
    runLifecycleAction: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");

const { toEventRequestError, requestClarification: realRequestClarification } = jest.requireActual("../../model/eventModel");

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

const round = (overrides = {}) => ({
  clarificationId: 8,
  round: 1,
  status: "OPEN",
  message: "Please confirm the stage size.",
  requestedAt: "2026-10-20T02:00:00+00:00",
  requestedBy: { userId: COORDINATOR_ID, name: "Coordinator C" },
  response: null,
  respondedAt: null,
  respondedBy: null,
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
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  eventModel.findValidationContext.mockResolvedValue({ allowedLayouts: ["NO_PREFERENCE", "Banquet", "Theatre"], venueIds: [3, 4], equipmentIds: [7] });
  eventModel.findEventClarifications.mockResolvedValue([round()]);
});

describe("POST /api/events/:id/clarifications (SPM-41 AC1)", () => {
  beforeEach(() => {
    signedInAs("COORDINATOR", COORDINATOR_ID);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow());
  });

  test("[SPM-41-TC-01] should_return_the_event_with_the_new_round_when_the_assigned_coordinator_requests_clarification", async () => {
    eventModel.requestClarification.mockResolvedValue({ clarificationId: 8, replayed: false });
    eventModel.findVisibleEvent
      .mockResolvedValueOnce(eventRow())
      .mockResolvedValueOnce(eventRow({ status: "AWAITING_CLARIFICATION", version: 5 }));

    const res = await post("/api/events/42/clarifications", { message: "  Please confirm the stage size.  ", version: 4 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Clarification requested. The organiser has been notified.");
    expect(res.body.event).toEqual(expect.objectContaining({ eventId: 42, status: "AWAITING_CLARIFICATION", version: 5 }));
    expect(res.body.event.permissions).toEqual(expect.objectContaining({ canRequestClarification: false, canResubmit: false }));
    expect(res.body.clarification).toEqual(round());
    expect(eventModel.requestClarification).toHaveBeenCalledWith({
      eventId: 42,
      actorId: COORDINATOR_ID,
      message: "Please confirm the stage size.",
      expectedVersion: 4,
      idempotencyKey: KEY,
    });
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

describe("POST /api/events/:id/resubmit (SPM-41 AC3/AC4)", () => {
  const awaiting = (overrides = {}) => eventRow({ status: "AWAITING_CLARIFICATION", ...overrides });

  beforeEach(() => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    eventModel.findVisibleEvent.mockResolvedValue(awaiting());
    eventModel.resubmitEvent.mockResolvedValue({ clarificationId: 8, replayed: false });
  });

  test("[SPM-41-TC-04] should_resubmit_with_a_response_and_amendments_and_return_the_answered_round", async () => {
    eventModel.findVisibleEvent.mockResolvedValueOnce(awaiting()).mockResolvedValueOnce(eventRow({ version: 6 }));
    eventModel.findEventClarifications.mockResolvedValue([round({ status: "RESPONDED", response: "Stage is 6m." })]);

    const res = await post("/api/events/42/resubmit", {
      response: " Stage is 6m. ",
      changes: { expectedAttendance: 150, venuePreferences: [4, 3] },
      version: 4,
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Your event request has been resubmitted for review.");
    expect(res.body.clarification).toEqual(expect.objectContaining({ status: "RESPONDED", response: "Stage is 6m." }));
    expect(res.body.event.permissions.canResubmit).toBe(false);
    expect(eventModel.resubmitEvent).toHaveBeenCalledWith({
      eventId: 42,
      actorId: ORGANISER_ID,
      response: "Stage is 6m.",
      input: { expectedAttendance: 150, venuePreferences: [4, 3] },
      expectedVersion: 4,
      idempotencyKey: KEY,
    });
  });

  test("[SPM-41-AC3] should_resubmit_with_a_response_only", async () => {
    const res = await post("/api/events/42/resubmit", { response: "Yes, 6m.", version: 4 });

    expect(res.status).toBe(200);
    expect(eventModel.resubmitEvent).toHaveBeenCalledWith(expect.objectContaining({ response: "Yes, 6m.", input: {} }));
  });

  test("[SPM-41-AC3] should_resubmit_with_amendments_only", async () => {
    const res = await post("/api/events/42/resubmit", { response: "  ", changes: { title: "Alumni Gala" }, version: 4 });

    expect(res.status).toBe(200);
    expect(eventModel.resubmitEvent).toHaveBeenCalledWith(expect.objectContaining({ response: null, input: { title: "Alumni Gala" } }));
  });

  test("[SPM-41-AC3] should_refuse_a_resubmission_with_neither_a_response_nor_a_change", async () => {
    const res = await post("/api/events/42/resubmit", { changes: {}, version: 4 });

    expect(res.status).toBe(400);
    expect(res.body.fields.response).toBe("Add a response or change at least one detail before resubmitting.");
    expect(eventModel.resubmitEvent).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_refuse_a_response_longer_than_2000_characters", async () => {
    const res = await post("/api/events/42/resubmit", { response: "x".repeat(2001), version: 4 });

    expect(res.status).toBe(400);
    expect(res.body.fields.response).toBe("Keep this to 2000 characters or fewer.");
  });

  test.each([
    ["registration settings", { isRegistrationEnabled: true }, "isRegistrationEnabled"],
    ["the organisation", { organisationId: 9 }, "organisationId"],
    ["the status", { status: "PLANNING" }, "status"],
  ])("[SPM-41-AC3] should_answer_403_when_the_owner_amends_%s", async (_label, changes, field) => {
    const res = await post("/api/events/42/resubmit", { response: "Done.", changes, version: 4 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FIELD_NOT_EDITABLE");
    expect(res.body.fields).toHaveProperty(field);
    expect(eventModel.resubmitEvent).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_400_for_an_unknown_change_or_body_field", async () => {
    const res = await post("/api/events/42/resubmit", { response: "Done.", changes: { colour: "red" }, version: 4 });
    const extra = await post("/api/events/42/resubmit", { response: "Done.", version: 4, note: "x" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("colour");
    expect(extra.status).toBe(400);
    expect(extra.body.fields).toHaveProperty("note");
  });

  test("[SPM-41-AC3] should_refuse_amendments_that_leave_an_incomplete_or_inconsistent_request", async () => {
    const blank = await post("/api/events/42/resubmit", { changes: { purpose: " " }, version: 4 });
    const order = await post("/api/events/42/resubmit", { changes: { endDatetime: inDays(19) }, version: 4 });

    expect(blank.status).toBe(400);
    expect(blank.body.fields).toHaveProperty("purpose");
    expect(order.status).toBe(400);
    expect(order.body.fields.endDatetime).toBe("End time must be after start time.");
    expect(eventModel.resubmitEvent).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_apply_the_48_hour_lead_time_only_to_an_amended_start", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(awaiting({ start_datetime: inDays(1), end_datetime: inDays(1.1) }));

    const unchanged = await post("/api/events/42/resubmit", { response: "Confirmed.", version: 4 });
    const amended = await post("/api/events/42/resubmit", { changes: { startDatetime: inDays(1.05) }, version: 4 });

    expect(unchanged.status).toBe(200);
    expect(amended.status).toBe(400);
    expect(amended.body.fields.startDatetime).toBe("Event date must be at least 48 hours in advance.");
  });

  test("[SPM-41-AC3] should_answer_403_when_a_same_organisation_organiser_resubmits", async () => {
    signedInAs("ORGANISER", COLLEAGUE_ID, [ORGANISATION_ID]);

    const res = await post("/api/events/42/resubmit", { response: "Done.", version: 4 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EVENT_READ_ONLY");
    expect(eventModel.resubmitEvent).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_403_when_a_coordinator_resubmits", async () => {
    signedInAs("COORDINATOR", COORDINATOR_ID);

    const res = await post("/api/events/42/resubmit", { response: "Done.", version: 4 });

    expect(res.status).toBe(403);
    expect(eventModel.resubmitEvent).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_409_with_the_current_event_when_the_version_is_stale", async () => {
    eventModel.resubmitEvent.mockRejectedValue(domainError("EVENT_VERSION_CONFLICT"));
    eventModel.findVisibleEvent.mockResolvedValueOnce(awaiting()).mockResolvedValueOnce(awaiting({ version: 5 }));

    const res = await post("/api/events/42/resubmit", { response: "Done.", version: 4 });

    expect(res.status).toBe(409);
    expect(res.body.event).toEqual(expect.objectContaining({ version: 5 }));
  });

  test("[SPM-41-AC3] should_explain_a_coordinator_schedule_clash_in_resubmit_terms", async () => {
    eventModel.resubmitEvent.mockRejectedValue(domainError("COORDINATOR_CONFLICT"));

    const res = await post("/api/events/42/resubmit", { changes: { startDatetime: inDays(25), endDatetime: inDays(25.1) }, version: 4 });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "COORDINATOR_CONFLICT",
      error: "The new dates clash with your coordinator's schedule. Choose different dates or contact your coordinator.",
    });
  });

  test("[SPM-41-AC3] should_answer_409_when_there_is_no_open_round", async () => {
    eventModel.resubmitEvent.mockRejectedValue(domainError("CLARIFICATION_NOT_OPEN"));

    const res = await post("/api/events/42/resubmit", { response: "Done.", version: 4 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CLARIFICATION_NOT_OPEN");
  });

  test("[SPM-41-AC3] should_answer_403_naming_the_status_when_the_event_is_no_longer_returned", async () => {
    eventModel.resubmitEvent.mockRejectedValue(domainError("TRANSITION_NOT_ALLOWED", { currentStatus: "UNDER_REVIEW" }));

    const res = await post("/api/events/42/resubmit", { response: "Done.", version: 4 });

    expect(res.status).toBe(403);
    expect(res.body.currentStatus).toBe("UNDER_REVIEW");
  });
});

describe("SPM-41 TC-03: planning stays blocked while the event is returned", () => {
  test("[SPM-41-TC-03] should_refuse_planning_actions_and_direct_edits_in_AWAITING_CLARIFICATION", async () => {
    signedInAs("COORDINATOR", COORDINATOR_ID);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status: "AWAITING_CLARIFICATION" }));
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
  test.each([
    ["the assigned coordinator, under review", "COORDINATOR", COORDINATOR_ID, "UNDER_REVIEW", { canRequestClarification: true, canResubmit: false }],
    ["the assigned coordinator, returned", "COORDINATOR", COORDINATOR_ID, "AWAITING_CLARIFICATION", { canRequestClarification: false, canResubmit: false }],
    ["the owner, returned", "ORGANISER", ORGANISER_ID, "AWAITING_CLARIFICATION", { canRequestClarification: false, canResubmit: true }],
    ["the owner, under review", "ORGANISER", ORGANISER_ID, "UNDER_REVIEW", { canRequestClarification: false, canResubmit: false }],
    ["a same-organisation organiser, returned", "ORGANISER", COLLEAGUE_ID, "AWAITING_CLARIFICATION", { canRequestClarification: false, canResubmit: false }],
  ])("[SPM-41-AC3] should_grant_the_right_flags_to_%s", async (_label, role, userId, status, flags) => {
    signedInAs(role, userId, [ORGANISATION_ID]);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status }));

    const res = await request(app).get("/api/events/42").set("Authorization", "Bearer token");

    expect(res.status).toBe(200);
    expect(res.body.event.permissions).toEqual(expect.objectContaining(flags));
  });
});

describe("SPM-41 model mapping", () => {
  test("[SPM-41-AC1] should_call_the_database_function_with_a_request_hash_and_return_the_round_id", async () => {
    supabase.rpc.mockResolvedValue({ data: { event: { event_id: 42 }, clarification: { clarification_id: 8 }, replayed: false }, error: null });

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

  test.each([
    [{ message: "RESUBMIT_EMPTY" }, { response: "Add a response or change at least one detail before resubmitting." }],
    [{ message: "INVALID_CLARIFICATION", details: "message:TOO_LONG" }, { message: "Keep this to 2000 characters or fewer." }],
    [{ message: "INVALID_CLARIFICATION", details: "message:REQUIRED" }, { message: "Enter the question for the organiser." }],
  ])("[SPM-41-AC1] should_report_database_validation_as_field_errors (%o)", (error, fields) => {
    expect(toEventRequestError(error)).toEqual(expect.objectContaining({ code: "VALIDATION_FAILED", fields }));
  });

  test("[SPM-41-AC3] should_report_a_missing_open_round_as_its_own_code", () => {
    expect(toEventRequestError({ message: "CLARIFICATION_NOT_OPEN" })).toEqual(expect.objectContaining({ code: "CLARIFICATION_NOT_OPEN" }));
  });
});
