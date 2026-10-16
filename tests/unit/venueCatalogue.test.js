jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({ getVenueCatalogue: jest.fn() }));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");

const send = () => request(app).get("/api/venues").set("Authorization", "Bearer token");

beforeEach(() => {
  jest.clearAllMocks();
  userModel.verifyAccessToken.mockResolvedValue("auth-venue");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: 9, role: "COORDINATOR", organisation_ids: [] });
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
    }
  );

  test.each(["COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF"])(
    "[AC-VC-001] should_allow_read_only_catalogue_access_for_%s",
    async (role) => {
      userModel.findUserByAuthId.mockResolvedValue({ user_id: 9, role });
      venueModel.getVenueCatalogue.mockResolvedValue({ venues: [{ venueId: 1, name: "Venue A" }], detailsAvailable: true });

      const response = await send();

      expect(response.status).toBe(200);
      expect(response.body.venues).toHaveLength(1);
      expect(venueModel.getVenueCatalogue).toHaveBeenCalledTimes(1);
    }
  );

  test.each(["ORGANISER", "TECH_SUPPORT", "ATTENDEE"])(
    "[AC-VC-001] should_return_403_for_%s_without_reading_the_catalogue",
    async (role) => {
      userModel.findUserByAuthId.mockResolvedValue({ user_id: 10, role });

      const response = await send();

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
      expect(venueModel.getVenueCatalogue).not.toHaveBeenCalled();
    }
  );

  test("[TC-VC-001] should_return_available_venues_read_only", async () => {
    venueModel.getVenueCatalogue.mockResolvedValue({
      venues: [{ venueId: 1, name: "Venue A" }, { venueId: 2, name: "Venue B" }],
      detailsAvailable: true,
    });

    const response = await send();

    expect(response.status).toBe(200);
    expect(response.body.venues).toHaveLength(2);
    expect(response.body.venues.map(({ name }) => name)).toEqual(["Venue A", "Venue B"]);
  });

  test("[TC-VC-002] should_return_an_empty_catalogue_without_a_mutation_path", async () => {
    const response = await send();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ venues: [], detailsAvailable: true });
    expect((await request(app).post("/api/venues").set("Authorization", "Bearer token").send({ name: "No write" })).status).toBe(404);
  });

  test("[TC-VC-003] should_return_only_venues_present_in_the_available_source", async () => {
    venueModel.getVenueCatalogue.mockResolvedValue({ venues: [{ venueId: 2, name: "Venue B" }], detailsAvailable: true });

    const response = await send();

    expect(response.status).toBe(200);
    expect(response.body.venues).toEqual([{ venueId: 2, name: "Venue B" }]);
    expect(response.body.venues.some(({ name }) => name === "Venue A")).toBe(false);
  });

  test("should_reject_a_non_catalogue_role", async () => {
    userModel.findUserByAuthId.mockResolvedValue({ user_id: 10, role: "ATTENDEE" });

    const response = await send();

    expect(response.status).toBe(403);
    expect(venueModel.getVenueCatalogue).not.toHaveBeenCalled();
  });
});
