// SPM-186 / SPM-189 decision routes with the model mocked: access,
// validation, error mapping and the response shape.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  approveVenueBooking: jest.fn(),
  rejectVenueBooking: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");
const { DECISION_MESSAGES } = require("../../validators/venueBookingValidator");

const venueError = (code, extra = {}) => Object.assign(new Error(code), { name: "VenueError", code, ...extra });
const post = (path, body) => request(app).post(path).set("Authorization", "Bearer token").send(body);

const decided = (status) => ({
  booking: { bookingId: 110, status, statusLabel: status === "APPROVED" ? "Approved" : "Rejected", reviewedByName: "Seed Venue Staff" },
  event: { eventId: 442, requestId: "REQ-000442", title: "Planning summit", status: "PLANNING" },
  otherBookings: [{ bookingId: 111, status: "PENDING" }],
});

beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-venue-staff");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: 7, role: "VENUE_STAFF", organisation_ids: [] });
  venueModel.approveVenueBooking.mockResolvedValue(decided("APPROVED"));
  venueModel.rejectVenueBooking.mockResolvedValue(decided("REJECTED"));
});

describe("Booking decision access", () => {
  const paths = ["/api/venues/bookings/110/approve", "/api/venues/bookings/110/reject"];

  test.each(paths)("should_return_401_without_a_session_for_%s", async (path) => {
    const response = await request(app).post(path).send({});

    expect(response.status).toBe(401);
    expect(venueModel.approveVenueBooking).not.toHaveBeenCalled();
    expect(venueModel.rejectVenueBooking).not.toHaveBeenCalled();
  });

  test.each(["ORGANISER", "COORDINATOR", "COORDINATOR_LEAD", "TECH_SUPPORT", "SAFETY_OFFICER", "ATTENDEE"])(
    "should_return_403_for_%s",
    async (role) => {
      userModel.findUserByAuthId.mockResolvedValue({ user_id: 8, role, organisation_ids: [] });

      for (const path of paths) {
        const response = await post(path, { reason: "No", expectedStatus: "PENDING" });
        expect(response.status).toBe(403);
      }
      expect(venueModel.approveVenueBooking).not.toHaveBeenCalled();
      expect(venueModel.rejectVenueBooking).not.toHaveBeenCalled();
    },
  );

  test.each(["abc", "0", "99999999999"])("should_answer_not_found_for_impossible_booking_id_%s", async (id) => {
    const response = await post(`/api/venues/bookings/${id}/approve`, {});

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("BOOKING_NOT_FOUND");
    expect(venueModel.approveVenueBooking).not.toHaveBeenCalled();
  });
});

describe("POST /api/venues/bookings/:bookingId/approve (SPM-186)", () => {
  test("[SPM-186-AC1] should_approve_as_the_signed_in_staff_member_and_return_the_booking", async () => {
    const response = await post("/api/venues/bookings/110/approve", { expectedStatus: "PENDING" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Venue booking approved.", ...decided("APPROVED") });
    expect(venueModel.approveVenueBooking).toHaveBeenCalledWith(7, 110, { expectedStatus: "PENDING", reason: null });
  });

  test("should_accept_an_empty_body", async () => {
    const response = await request(app).post("/api/venues/bookings/110/approve").set("Authorization", "Bearer token");

    expect(response.status).toBe(200);
    expect(venueModel.approveVenueBooking).toHaveBeenCalledWith(7, 110, { expectedStatus: null, reason: null });
  });

  test.each([
    [{ status: "APPROVED" }, "status"],
    [{ reviewedBy: 3 }, "reviewedBy"],
    [{ expectedStatus: "APPROVED" }, "expectedStatus"],
  ])("should_refuse_server_controlled_or_unknown_fields_%#", async (body, field) => {
    const response = await post("/api/venues/bookings/110/approve", body);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(response.body.fields)).toContain(field);
    expect(venueModel.approveVenueBooking).not.toHaveBeenCalled();
  });

  test("[SPM-186-AC5] should_tell_the_second_staff_member_the_booking_was_already_actioned", async () => {
    venueModel.approveVenueBooking.mockRejectedValue(venueError("BOOKING_ALREADY_DECIDED", { currentStatus: "REJECTED" }));

    const response = await post("/api/venues/bookings/110/approve", { expectedStatus: "PENDING" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "This booking has already been actioned by another staff member. Reload it to see the decision.",
      code: "BOOKING_ALREADY_DECIDED",
      currentStatus: "REJECTED",
    });
  });

  test.each([
    ["EVENT_NOT_IN_PLANNING", 409],
    ["VENUE_NOT_AVAILABLE", 409],
    ["VENUE_CAPACITY_EXCEEDED", 409],
    ["VENUE_BUFFERS_NOT_SET", 409],
    ["VENUE_BOOKING_CONFLICT", 409],
    ["VENUE_BLOCKED", 409],
    ["VENUE_DETAILS_UNAVAILABLE", 503],
    ["BOOKING_NOT_FOUND", 404],
  ])("should_map_%s_to_%i_with_a_stable_code", async (code, status) => {
    venueModel.approveVenueBooking.mockRejectedValue(venueError(code));

    const response = await post("/api/venues/bookings/110/approve", {});

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(response.body.error).toEqual(expect.any(String));
  });

  test("should_answer_a_safe_500_for_unexpected_failures", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    venueModel.approveVenueBooking.mockRejectedValue(new Error("relation venue_booking does not exist"));

    const response = await post("/api/venues/bookings/110/approve", {});

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("venue_booking");
    console.error.mockRestore();
  });
});

describe("POST /api/venues/bookings/:bookingId/reject (SPM-189)", () => {
  test("[SPM-189-AC3] should_reject_with_the_trimmed_reason_and_the_status_the_user_saw", async () => {
    const response = await post("/api/venues/bookings/110/reject", {
      reason: "  Hall closed for rewiring. Try Hall B on 5 Nov.  ",
      expectedStatus: "PENDING",
    });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Venue booking rejected.");
    expect(venueModel.rejectVenueBooking).toHaveBeenCalledWith(7, 110, {
      expectedStatus: "PENDING",
      reason: "Hall closed for rewiring. Try Hall B on 5 Nov.",
    });
  });

  test("[T32] should_allow_rejecting_an_approved_booking_with_a_reason", async () => {
    const response = await post("/api/venues/bookings/110/reject", { reason: "Emergency roof repair", expectedStatus: "APPROVED" });

    expect(response.status).toBe(200);
    expect(venueModel.rejectVenueBooking).toHaveBeenCalledWith(7, 110, { expectedStatus: "APPROVED", reason: "Emergency roof repair" });
  });

  test.each([undefined, "", "   ", 42])("[SPM-189-AC2] should_refuse_a_missing_reason_%p", async (reason) => {
    const response = await post("/api/venues/bookings/110/reject", { reason, expectedStatus: "PENDING" });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ reason: DECISION_MESSAGES.reasonRequired });
    expect(venueModel.rejectVenueBooking).not.toHaveBeenCalled();
  });

  test("should_refuse_a_reason_over_1000_characters", async () => {
    const response = await post("/api/venues/bookings/110/reject", { reason: "x".repeat(1001), expectedStatus: "PENDING" });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ reason: DECISION_MESSAGES.reasonTooLong });
  });

  test.each([undefined, "REJECTED", "CANCELLED"])("should_require_a_decidable_expected_status_%p", async (expectedStatus) => {
    const response = await post("/api/venues/bookings/110/reject", { reason: "Closed", expectedStatus });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ expectedStatus: DECISION_MESSAGES.expectedStatusInvalid });
  });

  test.each([["BOOKING_ALREADY_STARTED"], ["EVENT_NOT_ACTIVE"]])("should_map_%s_to_a_409", async (code) => {
    venueModel.rejectVenueBooking.mockRejectedValue(venueError(code));

    const response = await post("/api/venues/bookings/110/reject", { reason: "Closed", expectedStatus: "APPROVED" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(code);
  });

  test("[SPM-189-AC6] should_tell_the_user_when_the_booking_was_already_actioned", async () => {
    venueModel.rejectVenueBooking.mockRejectedValue(venueError("BOOKING_ALREADY_DECIDED", { currentStatus: "APPROVED" }));

    const response = await post("/api/venues/bookings/110/reject", { reason: "Closed", expectedStatus: "PENDING" });

    expect(response.status).toBe(409);
    expect(response.body.currentStatus).toBe("APPROVED");
  });

  test("should_answer_validation_failures_raised_by_the_database_as_field_errors", async () => {
    venueModel.rejectVenueBooking.mockRejectedValue(
      venueError("VALIDATION_FAILED", { fields: { reason: DECISION_MESSAGES.reasonRequired } }),
    );

    const response = await post("/api/venues/bookings/110/reject", { reason: "Closed", expectedStatus: "PENDING" });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ reason: DECISION_MESSAGES.reasonRequired });
  });
});
