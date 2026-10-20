jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  getVenueCatalogue: jest.fn(),
  getVenueAvailability: jest.fn(),
  updateVenueDetails: jest.fn(),
  getManagedVenue: jest.fn(),
  getManagedVenueDetails: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");

const venueError = (code, extra = {}) => Object.assign(new Error(code), { name: "VenueError", code, ...extra });
const as = (role) => {
  userModel.findUserByAuthId.mockResolvedValue({ user_id: 9, role, organisation_ids: [] });
};
const RANGE = "from=2026-11-04T00:00:00%2B08:00&to=2026-11-05T00:00:00%2B08:00";

beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-user");
  as("COORDINATOR");
  venueModel.getVenueAvailability.mockResolvedValue({ from: "a", to: "b", venues: [] });
  venueModel.getVenueCatalogue.mockResolvedValue({ venues: [], detailsAvailable: true, filtersNotChecked: [] });
});

describe("GET /api/venues/availability (SPM-74)", () => {
  const get = (query = RANGE) => request(app).get(`/api/venues/availability?${query}`).set("Authorization", "Bearer token");

  test("[SPM-74-AC1] should_return_401_without_a_session", async () => {
    const response = await request(app).get(`/api/venues/availability?${RANGE}`);
    expect(response.status).toBe(401);
    expect(venueModel.getVenueAvailability).not.toHaveBeenCalled();
  });

  test.each(["COORDINATOR", "VENUE_STAFF"])("[SPM-74-AC1] should_allow_%s", async (role) => {
    as(role);
    const response = await get(`${RANGE}&venueId=45,46&checkStart=2026-11-04T12:45:00%2B08:00&checkEnd=2026-11-04T14:00:00%2B08:00`);

    expect(response.status).toBe(200);
    const [query, viewer] = venueModel.getVenueAvailability.mock.calls[0];
    expect(query.venueIds).toEqual([45, 46]);
    expect(query.from.toISOString()).toBe("2026-11-03T16:00:00.000Z");
    expect(query.check.start.toISOString()).toBe("2026-11-04T04:45:00.000Z");
    expect(viewer.role).toBe(role);
  });

  test.each(["COORDINATOR_LEAD", "ORGANISER", "TECH_SUPPORT", "ATTENDEE"])("[SPM-74-TC11] should_deny_%s", async (role) => {
    as(role);
    const response = await get();

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
    expect(venueModel.getVenueAvailability).not.toHaveBeenCalled();
  });

  test.each([
    ["", "from"],
    ["from=2026-11-04&to=2026-11-05", "from"],
    ["from=2026-11-05T00:00:00%2B08:00&to=2026-11-04T00:00:00%2B08:00", "to"],
    ["from=2026-11-01T00:00:00%2B08:00&to=2026-12-15T00:00:00%2B08:00", "to"],
    [`${RANGE}&venueId=abc`, "venueId"],
    [`${RANGE}&checkStart=2026-11-04T12:45:00%2B08:00`, "check"],
    [`${RANGE}&status=AVAILABLE`, "status"],
  ])("should_reject_%p", async (query, field) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty(field);
    expect(venueModel.getVenueAvailability).not.toHaveBeenCalled();
  });

  test("[SPM-74-TC13] should_answer_503_and_no_availability_when_mongodb_is_unavailable", async () => {
    venueModel.getVenueAvailability.mockRejectedValue(venueError("AVAILABILITY_UNAVAILABLE"));

    const response = await get();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "AVAILABILITY_UNAVAILABLE",
      error: expect.stringContaining("no venue is shown as available"),
    });
  });
});

describe("PUT /api/venues/:venueId/details (SPM-73, T27)", () => {
  const put = (body) => request(app).put("/api/venues/7/details").set("Authorization", "Bearer token").send(body);

  beforeEach(() => as("VENUE_STAFF"));

  test("[SPM-73-AC] should_save_setup_turnaround_and_descriptive_details", async () => {
    venueModel.updateVenueDetails.mockResolvedValue({ details: { version: 2 }, changed: true });

    const response = await put({ version: 1, setupMinutes: 30, turnaroundMinutes: "45", facilities: [" Stage ", "stage", "PA"] });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Venue details updated.");
    expect(venueModel.updateVenueDetails).toHaveBeenCalledWith(9, 7, 1, { setupMinutes: 30, turnaroundMinutes: 45, facilities: ["Stage", "PA"] });
  });

  test.each(["COORDINATOR", "COORDINATOR_LEAD", "ORGANISER"])("[SPM-73-TC9] should_deny_%s", async (role) => {
    as(role);
    const response = await put({ version: 1, setupMinutes: 30 });

    expect(response.status).toBe(403);
    expect(venueModel.updateVenueDetails).not.toHaveBeenCalled();
  });

  test.each([
    [{ setupMinutes: 30 }, "version"],
    [{ version: 1, setupMinutes: -5 }, "setupMinutes"],
    [{ version: 1, turnaroundMinutes: 1441 }, "turnaroundMinutes"],
    [{ version: 1, turnaroundMinutes: 10.5 }, "turnaroundMinutes"],
    [{ version: 1, facilities: "Stage" }, "facilities"],
    [{ version: 1, description: "x".repeat(2001) }, "description"],
    [{ version: 1, capacity: 10 }, "capacity"],
    [{ version: 1 }, "body"],
  ])("should_reject_%p", async (body, field) => {
    const response = await put(body);

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty(field);
    expect(venueModel.updateVenueDetails).not.toHaveBeenCalled();
  });

  test("[Master 5.4.1] should_list_future_commitments_when_buffers_cannot_change", async () => {
    const commitments = [{ type: "BOOKING", bookingReference: "VB-000110" }, { type: "HOLD", requestId: "REQ-000500" }];
    venueModel.updateVenueDetails.mockRejectedValue(venueError("VENUE_HAS_FUTURE_COMMITMENTS", { commitments }));

    const response = await put({ version: 1, setupMinutes: 60 });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "VENUE_HAS_FUTURE_COMMITMENTS", commitments });
  });

  test.each([
    ["VENUE_DETAILS_VERSION_CONFLICT", 409],
    ["VENUE_DETAILS_UNAVAILABLE", 503],
    ["VENUE_NOT_FOUND", 404],
  ])("should_map_%s_to_%i", async (code, status) => {
    venueModel.updateVenueDetails.mockRejectedValue(venueError(code));

    const response = await put({ version: 1, setupMinutes: 60 });

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
  });
});

describe("GET /api/venues/:venueId details (SPM-73)", () => {
  test("should_include_the_mongodb_details_and_their_status", async () => {
    as("VENUE_STAFF");
    venueModel.getManagedVenue.mockResolvedValue({ venueId: 7, name: "Hall" });
    venueModel.getManagedVenueDetails.mockResolvedValue({ details: { setupMinutes: 30, version: 3 }, detailStatus: "CURRENT" });

    const response = await request(app).get("/api/venues/7").set("Authorization", "Bearer token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ venue: { venueId: 7, name: "Hall" }, details: { setupMinutes: 30, version: 3 }, detailStatus: "CURRENT" });
  });
});

describe("GET /api/venues search and filters (SPM-72 catalogue)", () => {
  const get = (query) => request(app).get(`/api/venues?${query}`).set("Authorization", "Bearer token");

  test("should_pass_the_filters_to_the_model", async () => {
    const response = await get("search=%20Hall%20&minCapacity=100&layout=Theater&facility=Stage&accessibility=Lift");

    expect(response.status).toBe(200);
    expect(venueModel.getVenueCatalogue).toHaveBeenCalledWith({
      search: "Hall",
      minCapacity: 100,
      layout: "Theater",
      facility: "Stage",
      accessibility: "Lift",
    });
  });

  test.each([
    ["minCapacity=0", "minCapacity"],
    ["minCapacity=abc", "minCapacity"],
    [`search=${"x".repeat(151)}`, "search"],
    ["status=ACTIVE", "status"],
  ])("should_reject_%p", async (query, field) => {
    const response = await get(query);

    expect(response.status).toBe(400);
    expect(response.body.fields).toHaveProperty(field);
  });
});
