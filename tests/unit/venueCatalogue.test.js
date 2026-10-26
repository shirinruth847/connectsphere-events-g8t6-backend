jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({ getVenueCatalogue: jest.fn() }));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");

const send = () => request(app).get("/api/venues").set("Authorization", "Bearer token");

const venue = (venueId, name) => ({
  venueId,
  name,
  address: `${name} Road`,
  maxCapacity: 100,
  operatingHours: "09:00-18:00",
  accessibilityFeatures: null,
  setupTurnaroundMinutes: 15,
  rooms: [],
  detailStatus: "NOT_AVAILABLE",
  description: null,
  facilities: null,
  supportedLayouts: null,
  emergencyAccess: null,
  knownRestrictions: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-venue");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: 9, role: "VENUE_STAFF", organisation_ids: [] });
  venueModel.getVenueCatalogue.mockResolvedValue({ venues: [], detailsAvailable: true });
});

describe("GET /api/venues", () => {
  test.each([undefined, "", "Basic token", "Bearer"])(
    "[TC-AUTH-001] should_return_401_when_authorization_is_%p",
    async (authorization) => {
      const requestBuilder = request(app).get("/api/venues");
      if (authorization !== undefined) requestBuilder.set("Authorization", authorization);

      const response = await requestBuilder;

      expect(response.status).toBe(401);
      expect(response.body.code).toBe("UNAUTHENTICATED");
      expect(userModel.verifyAccessToken).not.toHaveBeenCalled();
      expect(venueModel.getVenueCatalogue).not.toHaveBeenCalled();
    }
  );

  test.each(["VENUE_STAFF"])(
    "[SPM-72-AC1] should_allow_catalogue_access_for_%s",
    async (role) => {
      userModel.findUserByAuthId.mockResolvedValue({ user_id: 9, role });
      venueModel.getVenueCatalogue.mockResolvedValue({ venues: [venue(1, "Venue A")], detailsAvailable: true });

      const response = await send();

      expect(response.status).toBe(200);
      expect(response.body.venues).toHaveLength(1);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(venueModel.getVenueCatalogue).toHaveBeenCalledTimes(1);
    }
  );

  // Coordinators and Leads browse venues inside each event instead (SPM-72/74 AC1).
  test.each(["COORDINATOR", "COORDINATOR_LEAD", "ORGANISER", "TECH_SUPPORT", "ATTENDEE", "SAFETY_OFFICER"])(
    "[SPM-72-AC1] should_return_403_for_%s_without_reading_the_catalogue",
    async (role) => {
      userModel.findUserByAuthId.mockResolvedValue({ user_id: 10, role });

      const response = await send();

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
      expect(venueModel.getVenueCatalogue).not.toHaveBeenCalled();
    }
  );

  test.each([
    ["post", "/api/venues"],
    ["put", "/api/venues/1"],
    ["put", "/api/venues/1/status"],
    ["get", "/api/venues/manage"],
    ["get", "/api/venues/1"],
  ])(
    "[SPM-72-AC1][SPM-73-AC2] should_refuse_venue_maintenance_to_a_coordinator_for_%s_%s",
    async (method, path) => {
      userModel.findUserByAuthId.mockResolvedValue({ user_id: 9, role: "COORDINATOR", organisation_ids: [] });
      const response = await request(app)[method](path).set("Authorization", "Bearer token").send({ name: "No write" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    }
  );

  test.each([
    ["patch", "/api/venues/1"],
    ["delete", "/api/venues/1"],
    ["post", "/api/venues/1/rooms"],
    ["post", "/api/resources/bookings"],
    ["post", "/api/resources/equipment-requests"],
    ["get", "/api/resources/equipment"],
  ])(
    "[SPM-72-AC1] should_not_expose_a_write_route_for_%s_%s",
    async (method, path) => {
      const response = await request(app)[method](path).set("Authorization", "Bearer token").send({ name: "No write" });

      expect(response.status).toBe(404);
      expect(venueModel.getVenueCatalogue).not.toHaveBeenCalled();
    }
  );

  test("[TC-VC-001][SPM-72-AC3] should_return_each_venue_with_its_catalogue_fields", async () => {
    const catalogue = { venues: [venue(1, "Venue A"), venue(2, "Venue B")], detailsAvailable: true };
    venueModel.getVenueCatalogue.mockResolvedValue(catalogue);

    const response = await send();

    expect(response.status).toBe(200);
    expect(response.body).toEqual(catalogue);
  });

  test("[TC-VC-002][SPM-72-AC5] should_return_an_empty_list_when_no_venue_is_available", async () => {
    const response = await send();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ venues: [], detailsAvailable: true });
  });

  test("should_return_a_safe_500_when_postgres_fails", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    venueModel.getVenueCatalogue.mockRejectedValue(
      Object.assign(new Error("relation venue does not exist"), { code: "42P01" }),
    );

    const response = await send();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
    expect(JSON.stringify(response.body)).not.toContain("relation venue");
    console.error.mockRestore();
  });
});
