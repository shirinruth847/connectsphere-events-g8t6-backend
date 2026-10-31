// SPM-186: Venue Staff read the venue-relevant part of an event's history and
// each venue's own history. The models are mocked; the queries are covered in
// venueHistoryModel.test.js.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  hasReviewableBookings: jest.fn(),
  findVenueHistory: jest.fn(),
}));
jest.mock("../../model/activityModel", () => ({
  findEventHistory: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");
const activityModel = require("../../model/activityModel");

const get = (path) => request(app).get(path).set("Authorization", "Bearer token");
const page = { history: [{ historyId: 9, action: "VENUE_BOOKING_APPROVED" }], nextCursor: null };
const venueError = (code) => Object.assign(new Error(code), { name: "VenueError", code });
const cursorError = () => Object.assign(new Error("INVALID_CURSOR"), { name: "EventRequestError", code: "INVALID_CURSOR" });

const signInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-user");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: 7, role, organisation_ids: [] });
};

beforeEach(() => {
  jest.clearAllMocks();
  signInAs("VENUE_STAFF");
});

describe("GET /api/venues/bookings/events/:eventId/history", () => {
  test("[SPM-186-AC15] should_return_only_the_venue_relevant_history_of_an_event_with_bookings", async () => {
    venueModel.hasReviewableBookings.mockResolvedValue(true);
    activityModel.findEventHistory.mockResolvedValue(page);

    const response = await get("/api/venues/bookings/events/442/history?limit=5");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(page);
    expect(venueModel.hasReviewableBookings).toHaveBeenCalledWith(442);
    expect(activityModel.findEventHistory).toHaveBeenCalledWith(442, {
      limit: 5,
      cursor: null,
      audiences: ["ORGANISER_SAFE", "STAFF_ONLY"],
      fields: ["startDatetime", "endDatetime", "expectedAttendance", "preferredLayoutType", "accessibilityNeeds", "venuePreferences", "venueBookings"],
      actionPattern: "VENUE_*",
    });
  });

  test("[SPM-186-AC15] should_answer_not_found_for_a_draft_or_an_event_without_bookings", async () => {
    venueModel.hasReviewableBookings.mockResolvedValue(false);

    const response = await get("/api/venues/bookings/events/442/history");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("EVENT_NOT_FOUND");
    expect(activityModel.findEventHistory).not.toHaveBeenCalled();
  });

  test("should_answer_not_found_for_an_id_that_cannot_exist", async () => {
    const response = await get("/api/venues/bookings/events/abc/history");

    expect(response.status).toBe(404);
    expect(venueModel.hasReviewableBookings).not.toHaveBeenCalled();
  });

  test("should_reject_a_tampered_cursor", async () => {
    venueModel.hasReviewableBookings.mockResolvedValue(true);
    activityModel.findEventHistory.mockRejectedValue(cursorError());

    const response = await get("/api/venues/bookings/events/442/history?cursor=eyJsb2dJZCI6LTF9");

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ cursor: "Invalid page cursor." });
  });

  test.each(["COORDINATOR", "ORGANISER", "SAFETY_OFFICER"])("should_refuse_%s", async (role) => {
    signInAs(role);

    const response = await get("/api/venues/bookings/events/442/history");

    expect(response.status).toBe(403);
    expect(venueModel.hasReviewableBookings).not.toHaveBeenCalled();
  });
});

describe("GET /api/venues/:venueId/history", () => {
  test("[SPM-186-AC15] should_return_the_venue_history_page", async () => {
    venueModel.findVenueHistory.mockResolvedValue(page);

    const response = await get("/api/venues/45/history?limit=10");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(page);
    expect(venueModel.findVenueHistory).toHaveBeenCalledWith(45, { limit: 10, cursor: null });
  });

  test("should_answer_not_found_for_a_deleted_venue", async () => {
    venueModel.findVenueHistory.mockRejectedValue(venueError("VENUE_NOT_FOUND"));

    const response = await get("/api/venues/45/history");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("VENUE_NOT_FOUND");
  });

  test("should_reject_offset_paging", async () => {
    const response = await get("/api/venues/45/history?offset=20");

    expect(response.status).toBe(400);
    expect(venueModel.findVenueHistory).not.toHaveBeenCalled();
  });

  test("should_refuse_a_coordinator", async () => {
    signInAs("COORDINATOR");

    const response = await get("/api/venues/45/history");

    expect(response.status).toBe(403);
  });
});
