// SPM-190 routes: who may call each hold route and the error mapping. Since
// 1 November 2026 a booking request is the venue hold, so holds are no longer
// requested, placed, declined or extended; earlier holds can still be listed,
// withdrawn and released. The model is mocked; venueHoldModel.test.js covers it.
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

describe("retired hold routes (developer decision of 1 November 2026)", () => {
  test.each([
    ["COORDINATOR", "post", "/api/events/42/venue-holds", holdBody()],
    ["VENUE_STAFF", "post", "/api/venues/hold-requests/3/place", {}],
    ["VENUE_STAFF", "post", "/api/venues/hold-requests/3/decline", { reason: "Exams" }],
    ["VENUE_STAFF", "post", `/api/venues/holds/${HOLD_ID}/extend`, { days: 2 }],
  ])("should_answer_404_to_%s_%s_%s", async (role, method, path, body) => {
    signedInAs(role === "COORDINATOR" ? COORDINATOR_ID : VENUE_STAFF_ID, role);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow());

    const response = await send(method, path, body);

    expect(response.status).toBe(404);
    expect(venueModel.requestVenueHold).not.toHaveBeenCalled();
    expect(venueModel.placeVenueHold).not.toHaveBeenCalled();
    expect(venueModel.declineVenueHoldRequest).not.toHaveBeenCalled();
    expect(venueModel.extendVenueHold).not.toHaveBeenCalled();
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

describe("Venue Staff hold request list (SPM-190)", () => {
  test.each(["ORGANISER", "COORDINATOR_LEAD", "COORDINATOR", "ATTENDEE"])("should_refuse_the_list_for_%s", async (role) => {
    signedInAs(99, role);
    const response = await send("get", "/api/venues/hold-requests", undefined);
    expect(response.status).toBe(403);
    expect(venueModel.listHoldRequests).not.toHaveBeenCalled();
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

