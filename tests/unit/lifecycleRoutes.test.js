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
      domainError("READINESS_BLOCKED", { failures: ["NO_PRIMARY_VENUE", "OPEN_CHANGE_REQUEST"] })
    );
    const res = await send("post", "/api/events/42/submit-for-safety-review", { version: 7 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("READINESS_BLOCKED");
    expect(res.body.failures).toEqual([
      { code: "NO_PRIMARY_VENUE", message: "Choose one approved venue booking as the primary venue." },
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
