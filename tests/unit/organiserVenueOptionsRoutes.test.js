jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  getRequestVenueOptions: jest.fn(),
  getRequestVenueAvailability: jest.fn(),
  listSelectableVenuePhotos: jest.fn(),
  getSelectableVenuePhotoImage: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");

const ORGANISER_ID = 5;
const venueError = (code) => Object.assign(new Error(code), { name: "VenueError", code });

const signedInAs = (userId, role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};
const get = (path) => request(app).get(path).set("Authorization", "Bearer token");

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs(ORGANISER_ID, "ORGANISER");
  venueModel.getRequestVenueOptions.mockResolvedValue({ venues: [], detailsAvailable: true, availabilityChecked: true, filtersNotChecked: [] });
  venueModel.getRequestVenueAvailability.mockResolvedValue({ venue: { venueId: 7, busyPeriods: [] } });
  venueModel.listSelectableVenuePhotos.mockResolvedValue({ photos: [] });
});

describe("GET /api/venues/options (SPM-76)", () => {
  test("[SPM-76-AC1] should_return_401_without_a_session", async () => {
    const response = await request(app).get("/api/venues/options");
    expect(response.status).toBe(401);
    expect(venueModel.getRequestVenueOptions).not.toHaveBeenCalled();
  });

  test("[SPM-76-AC2][AC3] should_check_venues_against_the_unsaved_form_values", async () => {
    const response = await get(
      "/api/venues/options?search=Hall&minCapacity=100&layout=Theatre&sort=capacity&order=desc"
      + "&startDatetime=2026-12-01T10:00:00%2B08:00&endDatetime=2026-12-01T12:00:00%2B08:00"
      + "&expectedAttendance=150&preferredLayoutType=THEATRE&accessibilityNeeds=Hearing%20loop"
    );

    expect(response.status).toBe(200);
    const [need, viewer, options] = venueModel.getRequestVenueOptions.mock.calls[0];
    expect(need).toEqual({
      start_datetime: "2026-12-01T02:00:00.000Z",
      end_datetime: "2026-12-01T04:00:00.000Z",
      expected_attendance: 150,
      preferred_layout_type: "THEATRE",
      accessibility_needs: ["Hearing loop"],
    });
    expect(viewer.user_id).toBe(ORGANISER_ID);
    expect(options).toEqual({ filters: { search: "Hall", minCapacity: 100, layout: ["Theatre"] }, requiredFacilities: [], sort: "capacity", order: "desc" });
  });

  test("[SPM-76-AC3] should_list_venues_while_the_form_is_still_incomplete", async () => {
    const response = await get("/api/venues/options");
    expect(response.status).toBe(200);
    expect(venueModel.getRequestVenueOptions.mock.calls[0][0]).toMatchObject({ start_datetime: null, expected_attendance: null });
  });

  test("[SPM-76-AC2] should_report_invalid_values_against_the_field", async () => {
    const response = await get("/api/venues/options?minCapacity=0&expectedAttendance=-3&endDatetime=2026-12-01T09:00:00Z&startDatetime=2026-12-01T10:00:00Z&sort=price");

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.fields).sort()).toEqual(["endDatetime", "expectedAttendance", "minCapacity", "sort"]);
    expect(venueModel.getRequestVenueOptions).not.toHaveBeenCalled();
  });

  test.each(["COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "ATTENDEE"])(
    "[SPM-76-TC7] should_refuse_the_organiser_venue_list_to_%s",
    async (role) => {
      signedInAs(30, role);
      const response = await get("/api/venues/options");
      expect(response.status).toBe(403);
      expect(venueModel.getRequestVenueOptions).not.toHaveBeenCalled();
    }
  );
});

describe("GET /api/venues/options/:venueId/availability (SPM-76)", () => {
  const range = "from=2026-11-30T00:00:00%2B08:00&to=2026-12-07T00:00:00%2B08:00";

  test("[SPM-76-AC3] should_return_the_venue_calendar_with_the_requested_time_checked", async () => {
    const response = await get(`/api/venues/options/7/availability?${range}&checkStart=2026-12-01T13:00:00%2B08:00&checkEnd=2026-12-01T15:00:00%2B08:00`);

    expect(response.status).toBe(200);
    const [venueId, query, viewer] = venueModel.getRequestVenueAvailability.mock.calls[0];
    expect(venueId).toBe(7);
    expect(query.check).toEqual({ start: new Date("2026-12-01T05:00:00Z"), end: new Date("2026-12-01T07:00:00Z") });
    expect(viewer.user_id).toBe(ORGANISER_ID);
  });

  test("should_refuse_a_second_venue_in_the_query", async () => {
    const response = await get(`/api/venues/options/7/availability?${range}&venueId=8`);
    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty("venueId");
  });

  test("[SPM-76-TC4] should_not_find_a_venue_that_cannot_be_chosen", async () => {
    venueModel.getRequestVenueAvailability.mockRejectedValue(venueError("VENUE_NOT_FOUND"));
    const response = await get(`/api/venues/options/7/availability?${range}`);
    expect(response.status).toBe(404);
  });

  test("[SPM-76-AC7] should_say_availability_cannot_be_checked_when_mongodb_is_down", async () => {
    venueModel.getRequestVenueAvailability.mockRejectedValue(venueError("AVAILABILITY_UNAVAILABLE"));
    const response = await get(`/api/venues/options/7/availability?${range}`);
    expect(response.status).toBe(503);
  });

  test.each(["COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "ATTENDEE"])(
    "[SPM-76-TC7] should_refuse_the_organiser_calendar_to_%s",
    async (role) => {
      signedInAs(30, role);
      const response = await get(`/api/venues/options/7/availability?${range}`);
      expect(response.status).toBe(403);
    }
  );
});

describe("GET /api/venues/options/:venueId/photos (SPM-76 AC4)", () => {
  test("should_let_the_organiser_browse_photos_of_a_venue_they_can_choose", async () => {
    const response = await get("/api/venues/options/7/photos");
    expect(response.status).toBe(200);
    expect(venueModel.listSelectableVenuePhotos).toHaveBeenCalledWith(7);
  });

  test("should_refuse_photos_to_attendees", async () => {
    signedInAs(30, "ATTENDEE");
    const response = await get("/api/venues/options/7/photos");
    expect(response.status).toBe(403);
  });
});
