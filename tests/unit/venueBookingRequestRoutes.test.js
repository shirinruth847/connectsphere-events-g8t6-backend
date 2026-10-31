jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => ({
  ...jest.requireActual("../../model/eventModel"),
  findVisibleEvent: jest.fn(),
}));
jest.mock("../../model/venueModel", () => ({
  requestVenueBookings: jest.fn(),
  listEventVenueBookings: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");
const venueModel = require("../../model/venueModel");

const OWNER_ID = 5;
const COORDINATOR_ID = 20;
const OTHER_COORDINATOR_ID = 21;
const LEAD_ID = 10;
const VENUE_STAFF_ID = 30;
const venueError = (code, extra = {}) => Object.assign(new Error(code), { name: "VenueError", code, ...extra });

const signedInAs = (userId, role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};
const eventRow = (overrides = {}) => ({
  event_id: 42,
  organiser_id: OWNER_ID,
  coordinator_id: COORDINATOR_ID,
  supervising_lead_id: LEAD_ID,
  status: "PLANNING",
  start_datetime: "2030-03-10T01:00:00+00:00",
  end_datetime: "2030-03-10T09:00:00+00:00",
  ...overrides,
});
const item = (overrides = {}) => ({
  venueId: 7,
  label: "Main hall",
  start: "2030-03-10T02:00:00+00:00",
  end: "2030-03-10T04:00:00+00:00",
  expectedAttendance: 150,
  layout: "Theatre",
  ...overrides,
});
const send = (method, path, body, key = "spm179-request-0001") => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  if (key) req = req.set("Idempotency-Key", key);
  return body === undefined ? req : req.send(body);
};
const savedResult = (overrides = {}) => ({
  eventId: 42,
  requestId: "REQ-000042",
  arrangementVersion: 3,
  replayed: false,
  warnings: [],
  bookings: [{ bookingId: 900, venueId: 7, venueName: "Hall", status: "PENDING", statusLabel: "Pending", isPrimary: true }],
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs(COORDINATOR_ID, "COORDINATOR");
  eventModel.findVisibleEvent.mockResolvedValue(eventRow());
  venueModel.requestVenueBookings.mockResolvedValue(savedResult());
});

describe("POST /api/events/:id/venue-bookings (SPM-179)", () => {
  test("[SPM-179-AC1] should_return_401_without_a_session", async () => {
    const response = await request(app).post("/api/events/42/venue-bookings").send({ bookings: [item()] });
    expect(response.status).toBe(401);
    expect(venueModel.requestVenueBookings).not.toHaveBeenCalled();
  });

  test("[SPM-179-TC-01] should_save_the_request_for_the_assigned_coordinator_with_the_actor_from_the_session", async () => {
    const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item({ requiredFacilities: [" Stage ", "Stage"] })] });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({
      message: "Venue booking requested. Venue Staff will review it.",
      requestId: "REQ-000042",
      bookings: [expect.objectContaining({ bookingId: 900, statusLabel: "Pending" })],
    }));
    expect(venueModel.requestVenueBookings).toHaveBeenCalledWith({
      actorId: COORDINATOR_ID,
      eventId: 42,
      idempotencyKey: "spm179-request-0001",
      bookings: [{
        venueId: 7,
        label: "Main hall",
        start: "2030-03-10T02:00:00.000Z",
        end: "2030-03-10T04:00:00.000Z",
        expectedAttendance: 150,
        layout: "Theatre",
        requiredFacilities: ["Stage"],
        accessibilityNeeds: [],
        specialRequirements: null,
        isPrimary: false,
      }],
    });
  });

  test("[SPM-179-TC-17] should_answer_a_replay_with_200_and_the_stored_result", async () => {
    venueModel.requestVenueBookings.mockResolvedValue(savedResult({ replayed: true }));
    const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item()] });
    expect(response.status).toBe(200);
    expect(response.body.replayed).toBe(true);
  });

  test("[SPM-179-TC-19] should_answer_not_found_to_users_outside_the_event", async () => {
    for (const [userId, role] of [[OTHER_COORDINATOR_ID, "COORDINATOR"], [VENUE_STAFF_ID, "VENUE_STAFF"], [77, "ATTENDEE"]]) {
      signedInAs(userId, role);
      const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item()] });
      expect(response.status).toBe(404);
    }
    expect(venueModel.requestVenueBookings).not.toHaveBeenCalled();
  });

  test("[SPM-179-TC-19] should_forbid_the_owner_and_the_supervising_lead", async () => {
    for (const [userId, role] of [[OWNER_ID, "ORGANISER"], [LEAD_ID, "COORDINATOR_LEAD"]]) {
      signedInAs(userId, role);
      const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item()] });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    }
    expect(venueModel.requestVenueBookings).not.toHaveBeenCalled();
  });

  test("[SPM-179-AC1] should_refuse_the_assigned_coordinator_outside_planning", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status: "UNDER_REVIEW" }));
    const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item()] });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("EVENT_NOT_IN_PLANNING");
  });

  test("[SPM-179-TC-03] should_return_every_field_error_inside_its_venue_section", async () => {
    const response = await send("post", "/api/events/42/venue-bookings", {
      bookings: [item({ isPrimary: true }), { label: "", layout: "Theatre", status: "APPROVED" }],
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_FAILED");
    expect(response.body.fields).toEqual(expect.objectContaining({
      "bookings.1.venueId": "Venue is required.",
      "bookings.1.label": "Label is required.",
      "bookings.1.start": "Start date and time is required.",
      "bookings.1.expectedAttendance": "Expected attendance is required.",
      "bookings.1.status": "This field cannot be set.",
    }));
    expect(venueModel.requestVenueBookings).not.toHaveBeenCalled();
  });

  test("[SPM-179-AC13] should_require_an_idempotency_key", async () => {
    const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item()] }, null);
    expect(response.status).toBe(400);
    expect(response.body.fields.idempotencyKey).toBeDefined();
  });

  test("[SPM-179-TC-09] should_name_the_conflicting_period_in_singapore_time_against_its_venue", async () => {
    venueModel.requestVenueBookings.mockRejectedValue(venueError("BOOKING_CONFLICT", {
      index: 0,
      venueId: 7,
      conflicts: [{ type: "BOOKING", occupiedStart: "2030-03-10T02:30:00.000Z", occupiedEnd: "2030-03-10T05:45:00.000Z" }],
    }));
    const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item()] });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({ code: "BOOKING_CONFLICT", bookingIndex: 0, venueId: 7 }));
    expect(response.body.error).toMatch(/10:30.*13:45.*another booking/);
    expect(response.body.fields["bookings.0.start"]).toBe(response.body.error);
  });

  test("[SPM-179-TC-07] should_report_capacity_against_that_venue_only", async () => {
    venueModel.requestVenueBookings.mockRejectedValue(venueError("VENUE_CAPACITY_EXCEEDED", {
      index: 1, venueId: 8, capacity: 80, expectedAttendance: 81,
    }));
    const response = await send("post", "/api/events/42/venue-bookings", {
      bookings: [item({ isPrimary: true }), item({ venueId: 8, expectedAttendance: 81 })],
    });
    expect(response.status).toBe(409);
    expect(response.body.fields).toEqual({
      "bookings.1.expectedAttendance": "Expected attendance (81) exceeds this venue's capacity (80).",
    });
  });

  test.each([
    ["AVAILABILITY_UNAVAILABLE", 503, "Availability could not be checked. Try again later."],
    ["VENUE_BOOKINGS_UNAVAILABLE", 503, "Venue bookings cannot be requested right now. Try again shortly."],
    ["VENUE_LOCK_TIMEOUT", 409, "Another change to this event or venue is in progress. Try again."],
    ["IDEMPOTENCY_KEY_REUSED", 409, "This Idempotency-Key was already used for a different request."],
    // SPM-188 / T35: a refused conversion whose MongoDB undo failed.
    ["VENUE_CALENDAR_OUTCOME_UNKNOWN", 503, "The hold's outcome could not be confirmed. Reload the event before trying again."],
    ["HOLD_EXPIRED", 409, "This hold has expired, so it can no longer be confirmed. Request a booking instead."],
  ])("[SPM-179-TC-13] should_map_%s", async (code, status, message) => {
    venueModel.requestVenueBookings.mockRejectedValue(venueError(code));
    const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item()] });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code, error: message });
  });

  test("[SPM-179-TC-16] should_point_a_missing_primary_at_the_primary_choice", async () => {
    venueModel.requestVenueBookings.mockRejectedValue(venueError("PRIMARY_VENUE_REQUIRED"));
    const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item(), item({ venueId: 8 })] });
    expect(response.status).toBe(409);
    expect(response.body.fields).toEqual({ "bookings.primary": "Choose one primary venue." });
  });

  test("[SPM-179-AC16] should_hide_unexpected_failures", async () => {
    venueModel.requestVenueBookings.mockRejectedValue(new Error("connection reset"));
    const response = await send("post", "/api/events/42/venue-bookings", { bookings: [item()] });
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/connection reset/);
  });
});

describe("GET /api/events/:id/venue-bookings (SPM-179)", () => {
  beforeEach(() => {
    venueModel.listEventVenueBookings.mockResolvedValue([{ bookingId: 900, status: "PENDING", statusLabel: "Pending", isPrimary: true }]);
  });

  test("[SPM-179-AC12] should_list_the_bookings_and_offer_the_request_to_the_coordinator", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ event_type: "WORKSHOP" }));
    const response = await send("get", "/api/events/42/venue-bookings");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      eventId: 42,
      requestId: "REQ-000042",
      eventType: "WORKSHOP",
      eventTypeLabel: "Workshop",
      canRequestVenueBookings: true,
      bookings: [expect.objectContaining({ bookingId: 900, statusLabel: "Pending" })],
    });
  });

  test("[SPM-179-AC1] should_show_the_supervising_lead_the_bookings_read_only", async () => {
    signedInAs(LEAD_ID, "COORDINATOR_LEAD");
    const response = await send("get", "/api/events/42/venue-bookings");
    expect(response.status).toBe(200);
    expect(response.body.canRequestVenueBookings).toBe(false);
  });

  test("[SPM-179-AC1] should_not_offer_requests_outside_planning", async () => {
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status: "SAFETY_REVIEW" }));
    const response = await send("get", "/api/events/42/venue-bookings");
    expect(response.body.canRequestVenueBookings).toBe(false);
  });

  test("[SPM-179-TC-19] should_hide_the_list_from_other_coordinators", async () => {
    signedInAs(OTHER_COORDINATOR_ID, "COORDINATOR");
    const response = await send("get", "/api/events/42/venue-bookings");
    expect(response.status).toBe(404);
    expect(venueModel.listEventVenueBookings).not.toHaveBeenCalled();
  });
});
