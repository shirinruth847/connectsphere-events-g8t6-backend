jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  getVenueCatalogue: jest.fn(),
  findVenueBookings: jest.fn(),
  findVenueBooking: jest.fn(),
  findEventBookings: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");

const get = (path) => request(app).get(path).set("Authorization", "Bearer token");

const bookingItem = {
  bookingId: 110,
  bookingReference: "VB-000110",
  label: "Plenary hall",
  status: "PENDING",
  statusLabel: "Pending",
  venueId: 45,
  venueName: "Hall A",
  startDatetime: "2026-11-04T01:00:00+00:00",
  endDatetime: "2026-11-04T04:00:00+00:00",
  expectedAttendance: 120,
  submittedAt: "2026-10-07T13:32:08+00:00",
  event: { eventId: 442, requestId: "REQ-000442", title: "Planning", status: "PLANNING", eventType: "SEMINAR", eventTypeLabel: "Seminar" },
};

beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-venue-staff");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: 7, role: "VENUE_STAFF", organisation_ids: [] });
  venueModel.findVenueBookings.mockResolvedValue({ bookings: [bookingItem], hasMore: false, pendingCount: 1 });
});

describe("Venue booking review access (SPM-181 AC7)", () => {
  const paths = ["/api/venues/bookings", "/api/venues/bookings/110", "/api/venues/bookings/events/442"];

  test.each(paths)("[SPM-181-AC7] should_return_401_without_a_session_for_%s", async (path) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
    expect(venueModel.findVenueBookings).not.toHaveBeenCalled();
    expect(venueModel.findVenueBooking).not.toHaveBeenCalled();
    expect(venueModel.findEventBookings).not.toHaveBeenCalled();
  });

  test.each(["ORGANISER", "COORDINATOR", "COORDINATOR_LEAD", "TECH_SUPPORT", "ATTENDEE"])(
    "[SPM-181-AC7] should_return_403_for_%s",
    async (role) => {
      userModel.findUserByAuthId.mockResolvedValue({ user_id: 8, role, organisation_ids: [] });

      for (const path of paths) {
        const response = await get(path);
        expect(response.status).toBe(403);
        expect(response.body.code).toBe("FORBIDDEN");
      }
      expect(venueModel.findVenueBookings).not.toHaveBeenCalled();
      expect(venueModel.findVenueBooking).not.toHaveBeenCalled();
      expect(venueModel.findEventBookings).not.toHaveBeenCalled();
    }
  );
});

describe("GET /api/venues/bookings", () => {
  test("[SPM-181-AC1] should_list_bookings_with_the_pending_count", async () => {
    const response = await get("/api/venues/bookings");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ bookings: [bookingItem], hasMore: false, pendingCount: 1 });
    expect(venueModel.findVenueBookings).toHaveBeenCalledWith({
      status: null, venueId: null, eventId: null, from: null, to: null, limit: 100,
    });
  });

  test("[SPM-181-AC5] should_pass_every_filter_to_the_model", async () => {
    const response = await get(
      "/api/venues/bookings?status=PENDING&venueId=45&eventId=442&from=2026-11-04T00:00:00%2B08:00&to=2026-11-05T00:00:00%2B08:00"
    );

    expect(response.status).toBe(200);
    expect(venueModel.findVenueBookings).toHaveBeenCalledWith({
      status: "PENDING",
      venueId: 45,
      eventId: 442,
      from: "2026-11-03T16:00:00.000Z",
      to: "2026-11-04T16:00:00.000Z",
      limit: 100,
    });
  });

  test("[SPM-181-AC6] should_report_zero_pending_when_none_are_pending", async () => {
    venueModel.findVenueBookings.mockResolvedValue({ bookings: [], hasMore: false, pendingCount: 0 });

    const response = await get("/api/venues/bookings?status=PENDING");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ bookings: [], hasMore: false, pendingCount: 0 });
  });

  test.each([
    ["status=HELD", "status"],
    ["status=pending", "status"],
    ["venueId=abc", "venueId"],
    ["eventId=0", "eventId"],
    ["from=2026-11-04", "date"],
    ["from=2026-11-04T00:00:00%2B08:00&to=2026-11-03T00:00:00%2B08:00", "date"],
    ["limit=500", "limit"],
    ["organiserId=1", "organiserId"],
  ])("[SPM-181-AC5] should_return_400_for_%s", async (query, field) => {
    const response = await get(`/api/venues/bookings?${query}`);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("VALIDATION_FAILED");
    expect(response.body.fields).toHaveProperty(field);
    expect(venueModel.findVenueBookings).not.toHaveBeenCalled();
  });

  test("should_hide_database_failures", async () => {
    venueModel.findVenueBookings.mockRejectedValue({ code: "XX000", message: "relation secret_table failed" });

    const response = await get("/api/venues/bookings");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("GET /api/venues/bookings/:bookingId", () => {
  test("[SPM-181-AC2][SPM-181-AC3] should_return_the_booking_its_event_and_other_bookings", async () => {
    const detail = {
      booking: { bookingId: 110 },
      event: { eventId: 442, coordinatorName: "Seed Coordinator" },
      otherBookings: [{ bookingId: 111, venueName: "Room B", status: "PENDING" }],
    };
    venueModel.findVenueBooking.mockResolvedValue(detail);

    const response = await get("/api/venues/bookings/110");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(detail);
    expect(venueModel.findVenueBooking).toHaveBeenCalledWith(110);
  });

  test.each(["999", "0", "abc", "1e3"])("should_return_404_for_booking_%s", async (bookingId) => {
    venueModel.findVenueBooking.mockResolvedValue(null);

    const response = await get(`/api/venues/bookings/${bookingId}`);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("BOOKING_NOT_FOUND");
  });
});

describe("GET /api/venues/bookings/events/:eventId", () => {
  test("[SPM-181-AC4] should_return_every_booking_under_the_event", async () => {
    const view = { event: { eventId: 442 }, bookings: [{ bookingId: 110 }, { bookingId: 111 }] };
    venueModel.findEventBookings.mockResolvedValue(view);

    const response = await get("/api/venues/bookings/events/442");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(view);
    expect(venueModel.findEventBookings).toHaveBeenCalledWith(442);
  });

  test("[SPM-181-AC4] should_return_404_when_the_event_has_no_bookings", async () => {
    venueModel.findEventBookings.mockResolvedValue(null);

    const response = await get("/api/venues/bookings/events/5");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("EVENT_NOT_FOUND");
  });
});
