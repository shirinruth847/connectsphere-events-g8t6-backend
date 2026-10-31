// SPM-173 route-level unit tests: real Express app, routes, middleware and
// controller. Only the model functions that reach Supabase are mocked; the
// database rules themselves are covered by tests/integration/lifecycle.integration.test.js.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return {
    ...actual,
    findVisibleEvent: jest.fn(),
    findOrganiserEventRequests: jest.fn(),
    runLifecycleAction: jest.fn(),
    rejectSubmittedEvent: jest.fn(),
    getEventReadiness: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");

const COORDINATOR_ID = 21;
const KEY = "5f0f2a7c-1d7e-4c8e-9a51-6b2f1c3d4e5f";

const eventRow = (overrides = {}) => ({
  event_id: 42,
  organiser_id: 11,
  coordinator_id: COORDINATOR_ID,
  organisation_id: null,
  status: "PLANNING",
  title: "Annual Gala",
  version: 7,
  arrangement_version: 3,
  previously_confirmed: false,
  updated_at: "2026-10-19T07:14:14.406209+00:00",
  ...overrides,
});

const domainError = (code, extra = {}) => Object.assign(new Error(code), { name: "EventRequestError", code, ...extra });

const signedInAs = (role, userId = COORDINATOR_ID) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};

const send = (method, path, body, headers = {}) => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

const ACTIONS = [
  ["/api/events/42/submit-for-safety-review", "SUBMIT_FOR_SAFETY_REVIEW", "Event submitted for safety review."],
  ["/api/events/42/confirm", "CONFIRM", "Event confirmed."],
  ["/api/events/42/start-preparation", "START_PREPARATION", "Event preparation started."],
  ["/api/events/42/complete", "COMPLETE", "Event completed."],
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs("COORDINATOR");
  eventModel.findVisibleEvent.mockResolvedValue(eventRow());
});

describe("SPM-173 coordinator lifecycle actions", () => {
  test.each(ACTIONS)("[SPM-173-AC9-12] should_run_the_action_and_return_the_coordinator_view (%s)", async (path, action, message) => {
    eventModel.runLifecycleAction.mockResolvedValue({ event: { event_id: 42 }, replayed: false });
    eventModel.findVisibleEvent
      .mockResolvedValueOnce(eventRow())
      .mockResolvedValueOnce(eventRow({ status: "SAFETY_REVIEW", version: 8 }));

    const res = await send("post", path, { version: 7 }, { "Idempotency-Key": KEY });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(message);
    expect(res.body.event).toEqual(expect.objectContaining({ eventId: 42, status: "SAFETY_REVIEW", version: 8, arrangementVersion: 3 }));
    expect(eventModel.runLifecycleAction).toHaveBeenCalledWith({
      action,
      eventId: 42,
      actorId: COORDINATOR_ID,
      expectedVersion: 7,
      idempotencyKey: KEY,
    });
  });

  test.each([["ORGANISER"], ["COORDINATOR_LEAD"], ["VENUE_STAFF"], ["TECH_SUPPORT"], ["ATTENDEE"]])(
    "[SPM-173-TC-04] should_refuse_every_action_for_%s_with_403",
    async (role) => {
      signedInAs(role, 11);
      for (const [path] of ACTIONS) {
        const res = await send("post", path, { version: 7 });
        expect(res.status).toBe(403);
      }
      expect((await send("get", "/api/events/42/readiness")).status).toBe(403);
      expect(eventModel.runLifecycleAction).not.toHaveBeenCalled();
    }
  );

  test("[SPM-173-AC3] should_answer_not_found_when_the_event_is_not_assigned_to_the_coordinator", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(null);
    const res = await send("post", "/api/events/42/confirm", { version: 7 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
    expect(eventModel.runLifecycleAction).not.toHaveBeenCalled();
  });

  test.each([
    [{}, "version"],
    [{ version: 0 }, "version"],
    [{ version: "7a" }, "version"],
    [{ version: 7, status: "CONFIRMED" }, "status"],
  ])("[SPM-173-AC2] should_reject_a_bad_request_body_%j_with_400", async (body, field) => {
    const res = await send("post", "/api/events/42/confirm", body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.fields).toHaveProperty(field);
    expect(eventModel.runLifecycleAction).not.toHaveBeenCalled();
  });

  test("should_reject_a_malformed_idempotency_key_with_400", async () => {
    const res = await send("post", "/api/events/42/confirm", { version: 7 }, { "Idempotency-Key": "short" });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("idempotencyKey");
  });

  test("[SPM-173-AC3][SPM-173-TC-02] should_name_the_current_status_when_the_action_is_not_allowed", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError("TRANSITION_NOT_ALLOWED", { currentStatus: "PLANNING" }));
    const res = await send("post", "/api/events/42/confirm", { version: 7 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "This action is not allowed while the event is in PLANNING.",
      code: "TRANSITION_NOT_ALLOWED",
      currentStatus: "PLANNING",
    });
  });

  test("[SPM-173-AC5] should_return_409_with_the_current_event_for_a_stale_version", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError("EVENT_VERSION_CONFLICT", { currentStatus: "SAFETY_REVIEW" }));
    eventModel.findVisibleEvent
      .mockResolvedValueOnce(eventRow())
      .mockResolvedValueOnce(eventRow({ status: "SAFETY_REVIEW", version: 8 }));
    const res = await send("post", "/api/events/42/submit-for-safety-review", { version: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_VERSION_CONFLICT");
    expect(res.body.event).toEqual(expect.objectContaining({ status: "SAFETY_REVIEW", version: 8 }));
  });

  test("[SPM-173-AC9][SPM-173-TC-14] should_name_each_failing_readiness_condition", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(
      domainError("READINESS_BLOCKED", { failures: ["BOOKING_CONFLICT", "OPEN_CHANGE_REQUEST"] })
    );
    const res = await send("post", "/api/events/42/submit-for-safety-review", { version: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("READINESS_BLOCKED");
    expect(res.body.failures).toEqual([
      { code: "BOOKING_CONFLICT", message: "A venue booking overlaps another active booking at the same venue." },
      { code: "OPEN_CHANGE_REQUEST", message: "A change request is still open." },
    ]);
  });

  test.each([
    ["/api/events/42/confirm", "SAFETY_APPROVAL_REQUIRED"],
    ["/api/events/42/complete", "EVENT_NOT_ENDED"],
  ])("[SPM-173-TC-17][SPM-173-TC-24] should_return_409_for_%s_when_%s", async (path, code) => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError(code));
    const res = await send("post", path, { version: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
  });

  test("[SPM-173-TC-08] should_mark_an_idempotent_replay", async () => {
    eventModel.runLifecycleAction.mockResolvedValue({ event: { event_id: 42 }, replayed: true });
    const res = await send("post", "/api/events/42/confirm", { version: 7 }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });

  test("[SPM-173-AC8] should_return_readiness_with_a_message_per_failure", async () => {
    eventModel.getEventReadiness.mockResolvedValue({
      ready: false,
      failures: ["BOOKING_NOT_APPROVED"],
      status: "PLANNING",
      version: 7,
      arrangementVersion: 3,
    });
    const res = await send("get", "/api/events/42/readiness");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ready: false,
      failures: [{ code: "BOOKING_NOT_APPROVED", message: "Every venue booking must be approved; holds and pending requests do not count." }],
      status: "PLANNING",
      version: 7,
      arrangementVersion: 3,
    });
    expect(eventModel.getEventReadiness).toHaveBeenCalledWith({ eventId: 42, actorId: COORDINATOR_ID });
  });
});

// Exact response bodies, so a restructuring of the controller cannot change them.
describe("SPM-173 lifecycle response bodies", () => {
  const VERSION_MESSAGE = "Send the version of the event you loaded.";
  const KEY_MESSAGE = "Send an Idempotency-Key header of 8-128 letters, digits, '.', '_', ':' or '-' (a UUID works).";
  const invalid = (fields) => ({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });

  test.each([
    ["an array", [7], {}, { body: "Send the request as a JSON object." }],
    ["no version", {}, {}, { version: VERSION_MESSAGE }],
    ["an unknown field", { version: 7, status: "CONFIRMED" }, {}, { status: "This field cannot be set." }],
    ["a bad key", { version: 7 }, { "Idempotency-Key": "short" }, { idempotencyKey: KEY_MESSAGE }],
    [
      "several problems",
      { status: "CONFIRMED" },
      { "Idempotency-Key": "short" },
      { status: "This field cannot be set.", version: VERSION_MESSAGE, idempotencyKey: KEY_MESSAGE },
    ],
  ])("should_describe_%s_in_a_400", async (_name, body, headers, fields) => {
    const res = await send("post", "/api/events/42/confirm", body, headers);
    expect(res.status).toBe(400);
    expect(res.body).toEqual(invalid(fields));
  });

  test("should_report_at_most_ten_unknown_fields_with_shortened_names", async () => {
    const body = { version: 7, ["x".repeat(80)]: 1 };
    for (let index = 0; index < 12; index += 1) body[`extra${index}`] = index;
    const res = await send("post", "/api/events/42/confirm", body);
    const names = Object.keys(res.body.fields);
    expect(names).toHaveLength(10);
    expect(names[0]).toBe("x".repeat(60));
  });

  test("should_fall_back_to_a_general_message_when_the_status_is_unknown", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError("TRANSITION_NOT_ALLOWED"));
    const res = await send("post", "/api/events/42/confirm", { version: 7 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "This action is not allowed for this event in its current status.",
      code: "TRANSITION_NOT_ALLOWED",
      currentStatus: null,
    });
  });

  test("should_describe_readiness_codes_including_unknown_ones", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError("READINESS_BLOCKED", { failures: ["NO_ACTIVE_BOOKING", "NEW_CODE"] }));
    const res = await send("post", "/api/events/42/submit-for-safety-review", { version: 7 });
    expect(res.body).toEqual({
      error: "The event is not ready yet. Resolve the listed items, then try again.",
      code: "READINESS_BLOCKED",
      failures: [
        { code: "NO_ACTIVE_BOOKING", message: "Add at least one venue booking." },
        { code: "NEW_CODE", message: "This condition is not met yet." },
      ],
    });
  });

  test("should_send_an_empty_list_when_no_readiness_codes_are_given", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError("READINESS_BLOCKED"));
    const res = await send("post", "/api/events/42/confirm", { version: 7 });
    expect(res.status).toBe(409);
    expect(res.body.failures).toEqual([]);
  });

  test.each([
    ["SAFETY_APPROVAL_REQUIRED", 409, "The event needs a safety approval for its current arrangements before it can be confirmed."],
    ["EVENT_NOT_ENDED", 409, "The event can be completed only after it has ended."],
    ["COORDINATOR_INVARIANT", 409, "The event's coordinator assignment does not allow this action. Refresh and try again."],
    ["FORBIDDEN", 403, "You do not have permission to access this resource."],
    ["EVENT_NOT_FOUND", 404, "Event request not found."],
  ])("should_answer_%s_with_its_status_and_message", async (code, status, error) => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError(code));
    const res = await send("post", "/api/events/42/complete", { version: 7 });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error, code });
  });

  test("should_pass_an_unexpected_failure_to_the_error_handler", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(new Error("boom"));
    const res = await send("post", "/api/events/42/confirm", { version: 7 });
    expect(res.status).toBe(500);
  });

  test("should_answer_not_found_when_the_event_disappears_after_the_action", async () => {
    eventModel.runLifecycleAction.mockResolvedValue({ event: { event_id: 42 }, replayed: false });
    eventModel.findVisibleEvent.mockResolvedValueOnce(eventRow()).mockResolvedValueOnce(null);
    const res = await send("post", "/api/events/42/confirm", { version: 7 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
  });
});

describe("SPM-173 AC6 organiser label filter", () => {
  beforeEach(() => {
    signedInAs("ORGANISER", 11);
    eventModel.findOrganiserEventRequests.mockResolvedValue({ events: [], nextCursor: null });
  });

  test("[SPM-173-TC-10] should_expand_a_label_to_its_statuses", async () => {
    const res = await send("get", "/api/events/mine?label=Approved%20%26%20Planning");
    expect(res.status).toBe(200);
    expect(eventModel.findOrganiserEventRequests).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 11 }),
      expect.objectContaining({ status: null, statuses: ["PLANNING", "SAFETY_REVIEW"] })
    );
  });

  test("should_reject_an_unknown_label_or_a_label_with_a_status", async () => {
    expect((await send("get", "/api/events/mine?label=Approved")).status).toBe(400);
    expect((await send("get", "/api/events/mine?label=Draft&status=DRAFT")).status).toBe(400);
    expect(eventModel.findOrganiserEventRequests).not.toHaveBeenCalled();
  });
});


describe("SPM-39 feasibility acceptance", () => {
  const path = "/api/events/42/accept-feasibility";
  const approve = (body = { version: 7 }, headers = { "Idempotency-Key": KEY }) => send("post", path, body, headers);

  test("[SPM-39 TC1] returns the planning label after backend confirmation", async () => {
    eventModel.runLifecycleAction.mockResolvedValue({ event: { event_id: 42 }, replayed: false });
    eventModel.findVisibleEvent.mockResolvedValueOnce(eventRow({ status: "UNDER_REVIEW" }))
      .mockResolvedValueOnce(eventRow({ status: "PLANNING", version: 8 }));
    const res = await approve();
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Event request approved for planning.");
    expect(res.body.event).toMatchObject({ eventId: 42, status: "PLANNING", version: 8, statusLabel: "Approved & Planning" });
    expect(eventModel.runLifecycleAction).toHaveBeenCalledWith({ action: "ACCEPT_FEASIBILITY", eventId: 42, actorId: COORDINATOR_ID, expectedVersion: 7, idempotencyKey: KEY });
  });

  test.each(["ORGANISER", "COORDINATOR_LEAD", "VENUE_STAFF", "TECH_SUPPORT", "SAFETY_OFFICER", "ATTENDEE"])("[SPM-39] denies %s", async (role) => {
    signedInAs(role, 11);
    expect((await approve()).status).toBe(403);
    expect(eventModel.runLifecycleAction).not.toHaveBeenCalled();
  });

  test("[SPM-39] denies unsigned and unrelated callers", async () => {
    userModel.verifyAccessToken.mockResolvedValue(null);
    expect((await approve()).status).toBe(401);
    signedInAs("COORDINATOR");
    eventModel.findVisibleEvent.mockResolvedValue(null);
    expect((await approve()).status).toBe(404);
    expect(eventModel.runLifecycleAction).not.toHaveBeenCalled();
  });

  test.each([
    [{ version: 7 }, {}, "idempotencyKey"],
    [{}, { "Idempotency-Key": KEY }, "version"],
    [{ version: 0 }, { "Idempotency-Key": KEY }, "version"],
    [{ version: 7, status: "APPROVED" }, { "Idempotency-Key": KEY }, "status"],
    [{ version: 7, actorId: 99 }, { "Idempotency-Key": KEY }, "actorId"],
  ])("[SPM-39] rejects missing command guards and controlled fields %j", async (body, headers, field) => {
    const res = await approve(body, headers);
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty(field);
    expect(eventModel.runLifecycleAction).not.toHaveBeenCalled();
  });

  test("[SPM-39 TC2] reports missing fields as a conflict", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError("FEASIBILITY_REQUIREMENTS_MISSING", { missingFields: ["venuePreferences", "contactEmail"] }));
    const res = await approve();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "FEASIBILITY_REQUIREMENTS_MISSING", fields: { venuePreferences: "Venue preference is required.", contactEmail: "Organiser contact email is required." } });
  });

  test.each(["REJECTED", "CANCELLED", "PLANNING"])("[SPM-39 TC3/4] refuses %s without claiming success", async (status) => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError("TRANSITION_NOT_ALLOWED", { currentStatus: status }));
    const res = await approve();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "TRANSITION_NOT_ALLOWED", currentStatus: status });
    expect(res.body.event).toBeUndefined();
  });

  test("[SPM-39] returns current values on a stale command", async () => {
    eventModel.runLifecycleAction.mockRejectedValue(domainError("EVENT_VERSION_CONFLICT"));
    const res = await approve();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EVENT_VERSION_CONFLICT");
  });

  test("[SPM-39] marks replays and does not expose database errors", async () => {
    eventModel.runLifecycleAction.mockResolvedValue({ event: { event_id: 42 }, replayed: true });
    const replay = await approve();
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    eventModel.runLifecycleAction.mockRejectedValue(new Error("private SQL diagnostic"));
    const failed = await approve();
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain("private SQL");
  });
});

describe("SPM-40 rejection", () => {
  const reject = (body = { version: 7, reason: "Reason text" }, headers = { "Idempotency-Key": KEY }) => send("post", "/api/events/42/reject", body, headers);
  test("returns rejection only after database confirmation", async () => {
    eventModel.rejectSubmittedEvent.mockResolvedValue({ replayed: false });
    eventModel.findVisibleEvent.mockResolvedValueOnce(eventRow({ status: "UNDER_REVIEW" })).mockResolvedValueOnce(eventRow({ status: "REJECTED", version: 8 }));
    const response = await reject();
    expect(response.status).toBe(200);
    expect(response.body.event).toMatchObject({ status: "REJECTED", version: 8 });
    expect(eventModel.rejectSubmittedEvent).toHaveBeenCalledWith({ eventId: 42, actorId: COORDINATOR_ID, expectedVersion: 7, reason: "Reason text", idempotencyKey: KEY });
  });
  test.each(["", "   ", "123456789", "a".repeat(2001)])("rejects invalid notes %s", async reason => {
    const response = await reject({ version: 7, reason });
    expect(response.status).toBe(400); expect(response.body.fields.reason).toBeTruthy();
    expect(eventModel.rejectSubmittedEvent).not.toHaveBeenCalled();
  });
  test.each(["ORGANISER","COORDINATOR_LEAD","VENUE_STAFF","TECH_SUPPORT","SAFETY_OFFICER","ATTENDEE"])("denies %s", async role => {
    signedInAs(role,11); expect((await reject()).status).toBe(403);
    expect(eventModel.rejectSubmittedEvent).not.toHaveBeenCalled();
  });
  test("denies unauthenticated and unrelated coordinators",async()=>{
    userModel.verifyAccessToken.mockResolvedValue(null); expect((await reject()).status).toBe(401);
    signedInAs("COORDINATOR"); eventModel.findVisibleEvent.mockResolvedValue(null); expect((await reject()).status).toBe(404);
  });
  test.each([
    [{reason:"Reason text"},{"Idempotency-Key":KEY}],
    [{version:7,reason:"Reason text"},{}],
    [{version:7,reason:"Reason text",actorId:99},{"Idempotency-Key":KEY}],
  ])("requires command guards and rejects controlled fields",async(body,headers)=>{
    expect((await reject(body,headers)).status).toBe(400);
    expect(eventModel.rejectSubmittedEvent).not.toHaveBeenCalled();
  });
  test("refuses invalid states without success",async()=>{
    eventModel.rejectSubmittedEvent.mockRejectedValue(domainError("TRANSITION_NOT_ALLOWED",{currentStatus:"CANCELLED"}));
    const response=await reject(); expect(response.status).toBe(409); expect(response.body.event).toBeUndefined();
  });
  test("marks replay and hides private database failures",async()=>{
    eventModel.rejectSubmittedEvent.mockResolvedValue({replayed:true});
    expect((await reject()).headers["idempotent-replayed"]).toBe("true");
    eventModel.rejectSubmittedEvent.mockRejectedValue(new Error("private database diagnostic"));
    const response=await reject();expect(response.status).toBe(500);expect(JSON.stringify(response.body)).not.toContain("private database");
  });
});
