// SPM-190 routes: who may call each hold route, validation, Idempotency-Key
// and the error mapping. The model is mocked; venueHoldModel.test.js covers it.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => ({
  ...jest.requireActual("../../model/eventModel"),
  findVisibleEvent: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const venueModel = require("../../model/venueModel");

const COORDINATOR_ID = 20;
const VENUE_STAFF_ID = 30;
const HOLD_ID = "c".repeat(24);
const venueError = (code, extra = {}) => Object.assign(new Error(code), { name: "VenueError", code, ...extra });

const signedInAs = (userId, role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};
const send = (method, path, body, key = "spm190-request-0001") => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  if (key) req = req.set("Idempotency-Key", key);
  return body === undefined ? req : req.send(body);
};
const eventRow = (overrides = {}) => ({
  event_id: 42, organiser_id: 5, coordinator_id: COORDINATOR_ID, supervising_lead_id: 10, status: "PLANNING",
  start_datetime: "2030-03-10T01:00:00+00:00", end_datetime: "2030-03-10T09:00:00+00:00", ...overrides,
});
const holdBody = (overrides = {}) => ({
  venueId: 7, label: "Main hall", start: "2030-03-10T02:00:00+00:00", end: "2030-03-10T04:00:00+00:00", ...overrides,
});
const holdRequest = (overrides = {}) => ({ holdRequestId: 3, eventId: 42, venueId: 7, status: "PENDING", hold: null, ...overrides });

const mocked = ["requestVenueHold", "listEventHolds", "listHoldRequests", "placeVenueHold", "declineVenueHoldRequest", "withdrawVenueHoldRequest", "extendVenueHold", "releaseVenueHold"];

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of mocked) jest.spyOn(venueModel, name).mockResolvedValue(holdRequest());
  signedInAs(VENUE_STAFF_ID, "VENUE_STAFF");
});
afterEach(() => jest.restoreAllMocks());

describe("POST /api/events/:id/venue-holds (SPM-190 AC1)", () => {
  beforeEach(() => {
    signedInAs(COORDINATOR_ID, "COORDINATOR");
    eventModel.findVisibleEvent.mockResolvedValue(eventRow());
  });

  test("[SPM-190-AC1] should_record_the_assigned_coordinator's_request", async () => {
    const response = await send("post", "/api/events/42/venue-holds", holdBody());

    expect(response.status).toBe(201);
    expect(response.body.holdRequest).toMatchObject({ holdRequestId: 3, status: "PENDING" });
    expect(venueModel.requestVenueHold).toHaveBeenCalledWith({
      actorId: COORDINATOR_ID,
      eventId: 42,
      idempotencyKey: "spm190-request-0001",
      values: { venueId: 7, label: "Main hall", start: "2030-03-10T02:00:00.000Z", end: "2030-03-10T04:00:00.000Z", expectedAttendance: null, note: null },
    });
  });

  test("should_require_an_idempotency_key", async () => {
    const response = await send("post", "/api/events/42/venue-holds", holdBody(), null);

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty("idempotencyKey");
    expect(venueModel.requestVenueHold).not.toHaveBeenCalled();
  });

  test("[SPM-190-TC] should_refuse_a_window_outside_the_event", async () => {
    const response = await send("post", "/api/events/42/venue-holds", holdBody({ end: "2030-03-10T10:00:00+00:00" }));

    expect(response.status).toBe(400);
    expect(response.body.fields.start).toBe("Must be within the event's dates and times.");
  });

  test("should_refuse_an_event_that_is_not_in_planning", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status: "UNDER_REVIEW" }));

    const response = await send("post", "/api/events/42/venue-holds", holdBody());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("EVENT_NOT_IN_PLANNING");
  });

  test.each([
    ["the supervising Lead", 10, "COORDINATOR_LEAD"],
    ["the organiser", 5, "ORGANISER"],
  ])("should_refuse_%s", async (_name, userId, role) => {
    signedInAs(userId, role);

    const response = await send("post", "/api/events/42/venue-holds", holdBody());

    expect([403, 404]).toContain(response.status);
    expect(venueModel.requestVenueHold).not.toHaveBeenCalled();
  });

  test.each([
    ["HOLD_REQUEST_EXISTS", 409],
    ["HOLD_TOO_LATE", 409],
    ["VENUE_NOT_BOOKABLE", 409],
    ["VENUE_NOT_FOUND", 404],
    ["IDEMPOTENCY_KEY_REUSED", 409],
  ])("should_map_%s_to_%i", async (code, status) => {
    venueModel.requestVenueHold.mockRejectedValue(venueError(code));

    const response = await send("post", "/api/events/42/venue-holds", holdBody());

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
  });

  test("should_report_a_window_outside_the_event_found_by_the_database_on_its_field", async () => {
    venueModel.requestVenueHold.mockRejectedValue(venueError("HOLD_OUTSIDE_EVENT"));

    const response = await send("post", "/api/events/42/venue-holds", holdBody());

    expect(response.status).toBe(400);
    expect(response.body.fields.start).toBe("Must be within the event's dates and times.");
  });
});

describe("GET /api/events/:id/venue-holds", () => {
  test("should_list_the_event's_holds_for_its_coordinator", async () => {
    signedInAs(COORDINATOR_ID, "COORDINATOR");
    eventModel.findVisibleEvent.mockResolvedValue(eventRow());
    venueModel.listEventHolds.mockResolvedValue([holdRequest()]);

    const response = await send("get", "/api/events/42/venue-holds", undefined, null);

    expect(response.status).toBe(200);
    expect(response.body.holds).toHaveLength(1);
    expect(venueModel.listEventHolds).toHaveBeenCalledWith(42);
  });

  test("should_refuse_Venue_Staff", async () => {
    const response = await send("get", "/api/events/42/venue-holds", undefined, null);

    expect(response.status).toBe(403);
  });
});

describe("Venue Staff hold routes (SPM-190 AC1, AC4, AC6)", () => {
  const staffCalls = [
    ["get", "/api/venues/hold-requests", undefined],
    ["post", "/api/venues/hold-requests/3/place", {}],
    ["post", "/api/venues/hold-requests/3/decline", { reason: "Exams" }],
    ["post", `/api/venues/holds/${HOLD_ID}/extend`, { days: 2 }],
  ];

  test.each(["ORGANISER", "COORDINATOR_LEAD", "COORDINATOR", "ATTENDEE"])("should_refuse_every_staff_route_for_%s", async (role) => {
    signedInAs(99, role);
    for (const [method, path, body] of staffCalls) {
      const response = await send(method, path, body);
      expect(response.status).toBe(403);
    }
    expect(venueModel.placeVenueHold).not.toHaveBeenCalled();
    expect(venueModel.extendVenueHold).not.toHaveBeenCalled();
  });

  test("should_list_hold_requests_and_filter_by_status", async () => {
    venueModel.listHoldRequests.mockResolvedValue({ requests: [], pendingCount: 0 });

    const response = await send("get", "/api/venues/hold-requests?status=PENDING", undefined, null);

    expect(response.status).toBe(200);
    expect(venueModel.listHoldRequests).toHaveBeenCalledWith({ status: "PENDING" });
  });

  test("should_refuse_an_unknown_status_or_query_field", async () => {
    const response = await send("get", "/api/venues/hold-requests?status=OPEN&page=2", undefined, null);

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.fields).sort()).toEqual(["page", "status"]);
  });

  test("[SPM-190-AC1] should_place_a_hold_with_an_idempotency_key", async () => {
    venueModel.placeVenueHold.mockResolvedValue(holdRequest({ status: "PLACED", hold: { holdId: HOLD_ID } }));

    const response = await send("post", "/api/venues/hold-requests/3/place", {});

    expect(response.status).toBe(200);
    expect(venueModel.placeVenueHold).toHaveBeenCalledWith({ actorId: VENUE_STAFF_ID, requestId: 3, idempotencyKey: "spm190-request-0001" });
  });

  test("should_refuse_placing_without_an_idempotency_key", async () => {
    const response = await send("post", "/api/venues/hold-requests/3/place", undefined, null);

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty("idempotencyKey");
  });

  test.each([
    ["VENUE_BOOKING_CONFLICT", 409],
    ["VENUE_HELD", 409],
    ["VENUE_BLOCKED", 409],
    ["HOLD_TOO_LATE", 409],
    ["VENUE_BUFFERS_NOT_SET", 409],
    ["HOLD_REQUEST_NOT_FOUND", 404],
    ["VENUE_CALENDAR_UNAVAILABLE", 503],
  ])("[SPM-190-AC4] should_map_a_placement_failure_%s_to_%i", async (code, status) => {
    venueModel.placeVenueHold.mockRejectedValue(venueError(code));

    const response = await send("post", "/api/venues/hold-requests/3/place", {});

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
  });

  test("should_return_the_current_status_when_a_request_was_already_actioned", async () => {
    venueModel.placeVenueHold.mockRejectedValue(venueError("HOLD_REQUEST_DECIDED", { currentStatus: "WITHDRAWN" }));

    const response = await send("post", "/api/venues/hold-requests/3/place", {});

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "HOLD_REQUEST_DECIDED", currentStatus: "WITHDRAWN" });
  });

  test("should_decline_with_a_reason", async () => {
    const response = await send("post", "/api/venues/hold-requests/3/decline", { reason: " Reserved for exams " }, null);

    expect(response.status).toBe(200);
    expect(venueModel.declineVenueHoldRequest).toHaveBeenCalledWith({ actorId: VENUE_STAFF_ID, requestId: 3, reason: "Reserved for exams" });
  });

  test("should_refuse_a_decline_without_a_reason", async () => {
    const response = await send("post", "/api/venues/hold-requests/3/decline", {}, null);

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty("reason");
    expect(venueModel.declineVenueHoldRequest).not.toHaveBeenCalled();
  });

  test("[SPM-190-AC6] should_extend_by_the_chosen_days", async () => {
    const response = await send("post", `/api/venues/holds/${HOLD_ID}/extend`, { days: 3 }, null);

    expect(response.status).toBe(200);
    expect(venueModel.extendVenueHold).toHaveBeenCalledWith({ actorId: VENUE_STAFF_ID, holdId: HOLD_ID, days: 3 });
  });

  test.each([
    ["HOLD_ALREADY_EXTENDED", 409],
    ["HOLD_EXPIRED", 409],
    ["HOLD_NOT_ACTIVE", 409],
    ["HOLD_NOT_FOUND", 404],
  ])("[SPM-190-AC6] should_map_an_extension_failure_%s_to_%i", async (code, status) => {
    venueModel.extendVenueHold.mockRejectedValue(venueError(code));

    const response = await send("post", `/api/venues/holds/${HOLD_ID}/extend`, { days: 3 }, null);

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
  });

  test("[SPM-190-AC6] should_report_an_extension_past_the_cutoff_on_the_days_field", async () => {
    venueModel.extendVenueHold.mockRejectedValue(venueError("HOLD_EXTENSION_TOO_LONG"));

    const response = await send("post", `/api/venues/holds/${HOLD_ID}/extend`, { days: 7 }, null);

    expect(response.status).toBe(400);
    expect(response.body.fields.days).toMatch(/24 hours before setup/);
  });

  test("should_answer_404_for_ids_that_cannot_exist", async () => {
    expect((await send("post", "/api/venues/hold-requests/abc/place", {})).body.code).toBe("HOLD_REQUEST_NOT_FOUND");
    expect((await send("post", "/api/venues/holds/xyz/extend", { days: 1 }, null)).body.code).toBe("HOLD_NOT_FOUND");
  });

  test("should_hide_unexpected_errors", async () => {
    venueModel.placeVenueHold.mockRejectedValue(new Error("connection reset"));

    const response = await send("post", "/api/venues/hold-requests/3/place", {});

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/connection reset/);
  });
});

describe("release and withdraw (Venue Staff or the coordinator)", () => {
  test.each([
    ["Venue Staff", VENUE_STAFF_ID, "VENUE_STAFF"],
    ["a coordinator", COORDINATOR_ID, "COORDINATOR"],
  ])("should_let_%s_release_a_hold", async (_name, userId, role) => {
    signedInAs(userId, role);

    const response = await send("post", `/api/venues/holds/${HOLD_ID}/release`, undefined, null);

    expect(response.status).toBe(200);
    expect(venueModel.releaseVenueHold).toHaveBeenCalledWith({ actorId: userId, holdId: HOLD_ID });
  });

  test("should_refuse_release_for_other_roles", async () => {
    signedInAs(10, "COORDINATOR_LEAD");

    const response = await send("post", `/api/venues/holds/${HOLD_ID}/release`, undefined, null);

    expect(response.status).toBe(403);
  });

  test("should_pass_a_database_refusal_through_as_forbidden", async () => {
    signedInAs(21, "COORDINATOR");
    venueModel.releaseVenueHold.mockRejectedValue(venueError("FORBIDDEN"));

    const response = await send("post", `/api/venues/holds/${HOLD_ID}/release`, undefined, null);

    expect(response.status).toBe(403);
  });

  test("should_let_the_coordinator_withdraw_and_refuse_Venue_Staff", async () => {
    expect((await send("post", "/api/venues/hold-requests/3/withdraw", undefined, null)).status).toBe(403);

    signedInAs(COORDINATOR_ID, "COORDINATOR");
    const response = await send("post", "/api/venues/hold-requests/3/withdraw", undefined, null);

    expect(response.status).toBe(200);
    expect(venueModel.withdrawVenueHoldRequest).toHaveBeenCalledWith({ actorId: COORDINATOR_ID, requestId: 3 });
  });
});
