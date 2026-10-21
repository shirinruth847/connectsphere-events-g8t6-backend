jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  findVenueBookings: jest.fn(),
  listManagedVenues: jest.fn(),
  listVenueOptions: jest.fn(),
  getManagedVenue: jest.fn(),
  getManagedVenueDetails: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");

const as = (role) => userModel.findUserByAuthId.mockResolvedValue({ user_id: 7, role, organisation_ids: [] });
const get = (path) => request(app).get(path).set("Authorization", "Bearer token");

beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-user");
  as("VENUE_STAFF");
  venueModel.findVenueBookings.mockResolvedValue({ bookings: [], hasMore: false, pendingCount: 0 });
  venueModel.listManagedVenues.mockResolvedValue({ venues: [], nextOffset: null, detailsAvailable: true, sortNotChecked: false });
  venueModel.listVenueOptions.mockResolvedValue({ venues: [{ venueId: 9, name: "New Hall", status: "ACTIVE" }] });
});

describe("GET /api/venues/bookings search and sort (SPM-181)", () => {
  test("[TC-VENUE-181-20] should_pass_search_sort_and_order_to_the_model", async () => {
    const response = await get("/api/venues/bookings?q=%20grand%20&sort=attendance&order=desc&status=PENDING");

    expect(response.status).toBe(200);
    expect(venueModel.findVenueBookings).toHaveBeenCalledWith(expect.objectContaining({
      q: "grand", sort: "attendance", order: "desc", status: "PENDING",
    }));
  });

  test("[TC-VENUE-181-21] should_return_400_for_an_unknown_sort_without_querying", async () => {
    const response = await get("/api/venues/bookings?sort=lastOpened");

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty("sort");
    expect(venueModel.findVenueBookings).not.toHaveBeenCalled();
  });
});

describe("GET /api/venues/manage sort (SPM-181)", () => {
  test("[TC-VENUE-181-22] should_pass_sort_and_order_with_the_filters", async () => {
    const response = await get("/api/venues/manage?search=hall&sort=turnaroundMinutes&order=desc&limit=10");

    expect(response.status).toBe(200);
    expect(venueModel.listManagedVenues).toHaveBeenCalledWith(
      { search: "hall", sort: "turnaroundMinutes", order: "desc" },
      { limit: 10, offset: 0 },
    );
  });

  test("[TC-VENUE-181-23] should_reject_an_unknown_venue_sort", async () => {
    const response = await get("/api/venues/manage?sort=price");

    expect(response.status).toBe(400);
    expect(venueModel.listManagedVenues).not.toHaveBeenCalled();
  });
});

describe("GET /api/venues/manage/options (SPM-181)", () => {
  test("[TC-VENUE-181-24] should_return_the_venue_options_to_venue_staff", async () => {
    const response = await get("/api/venues/manage/options");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ venues: [{ venueId: 9, name: "New Hall", status: "ACTIVE" }] });
    // "options" is a path, not a venue ID.
    expect(venueModel.getManagedVenue).not.toHaveBeenCalled();
  });

  test.each(["COORDINATOR", "COORDINATOR_LEAD", "ORGANISER", "TECH_SUPPORT", "ATTENDEE"])(
    "[TC-VENUE-181-25] should_return_403_when_the_role_is_%s",
    async (role) => {
      as(role);
      const response = await get("/api/venues/manage/options");

      expect(response.status).toBe(403);
      expect(venueModel.listVenueOptions).not.toHaveBeenCalled();
    }
  );

  test("[TC-VENUE-181-26] should_return_401_without_a_session", async () => {
    const response = await request(app).get("/api/venues/manage/options");
    expect(response.status).toBe(401);
  });
});
