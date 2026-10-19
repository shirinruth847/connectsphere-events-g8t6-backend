// Route-level unit tests: real Express app, routes and middleware, with the
// models (which call Supabase) mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel");
jest.mock("../../model/registrationModel");

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const { findOrganiserEventRequests } = require("../../model/eventModel");
const { findAttendeeRegistrations } = require("../../model/registrationModel");

const profileFor = (role) => ({
  user_id: 11,
  email: `${role.toLowerCase()}@connectsphere.test`,
  name: "Synthetic User",
  role,
  organisation_ids: [],
});

const signedInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue(profileFor(role));
};

const getWithToken = (path) => request(app).get(path).set("Authorization", "Bearer token");

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/auth/login", () => {
  test("[TC-AUTH-022] should_return_404_when_backend_login_is_requested_because_the_browser_signs_in_with_supabase", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "a@connectsphere.test", password: "pw" });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/auth/me", () => {
  test.each([
    ["TC-LOGIN-001", "COORDINATOR", "/dashboard"],
    ["TC-LOGIN-002", "VENUE_STAFF", "/dashboard"],
    ["TC-LOGIN-003", "TECH_SUPPORT", "/dashboard"],
    ["TC-LOGIN-004", "ATTENDEE", "/my-registrations"],
    ["TC-LOGIN-005", "ORGANISER", "/dashboard"],
  ])("[%s] should_return_profile_roles_and_home_path_when_%s_is_signed_in", async (_id, role, homePath) => {
    signedInAs(role);

    const res = await getWithToken("/api/auth/me");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.user).toEqual({
      user_id: 11,
      email: `${role.toLowerCase()}@connectsphere.test`,
      name: "Synthetic User",
      role,
      roles: [role],
      home_path: homePath,
    });
  });

  test("[TC-LOGIN-011] should_return_401_with_no_store_when_token_is_missing", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Please log in to continue.", code: "UNAUTHENTICATED" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("[TC-LOGIN-013] should_return_401_when_token_is_rejected_or_revoked", async () => {
    userModel.verifyAccessToken.mockResolvedValue(null);

    const res = await getWithToken("/api/auth/me");

    expect(res.status).toBe(401);
    expect(userModel.findUserByAuthId).not.toHaveBeenCalled();
  });

  test("[TC-AUTH-002] should_return_401_when_auth_user_has_no_active_profile", async () => {
    userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
    userModel.findUserByAuthId.mockResolvedValue(null);

    const res = await getWithToken("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  test("[TC-AUTH-018] should_return_500_when_supabase_auth_is_unavailable", async () => {
    userModel.verifyAccessToken.mockRejectedValue(new Error("[Supabase Auth Error] 503"));

    const res = await getWithToken("/api/auth/me");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("POST /api/auth/logout", () => {
  test("[TC-LOGIN-013] should_revoke_presented_session_when_logging_out", async () => {
    const res = await request(app).post("/api/auth/logout").set("Authorization", "Bearer token");

    expect(res.status).toBe(204);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(userModel.revokeSession).toHaveBeenCalledWith("token");
  });

  test("[TC-AUTH-010] should_return_204_when_logout_has_no_token", async () => {
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(204);
    expect(userModel.revokeSession).not.toHaveBeenCalled();
  });

  test("[TC-AUTH-018] should_return_generic_500_when_session_revocation_fails", async () => {
    userModel.revokeSession.mockRejectedValue(new Error("[Supabase Auth Error] 500"));

    const res = await request(app).post("/api/auth/logout").set("Authorization", "Bearer token");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });
});

describe("GET /api/events/mine", () => {
  test("[TC-LOGIN-005] should_return_scoped_requests_and_page_info_when_organiser_lists_requests", async () => {
    signedInAs("ORGANISER");
    findOrganiserEventRequests.mockResolvedValue({ events: [{ eventId: 1, isOwner: true }], nextCursor: "next" });

    const res = await getWithToken("/api/events/mine?limit=20");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      events: [{ eventId: 1, isOwner: true }],
      nextCursor: "next",
    });
    expect(findOrganiserEventRequests).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 11 }),
      { limit: 20, cursor: null, status: null },
    );
  });

  test("[TC-AUTH-021] should_return_400_without_querying_when_limit_is_out_of_range", async () => {
    signedInAs("ORGANISER");

    const res = await getWithToken("/api/events/mine?limit=500");

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ limit: "Limit must be a whole number from 1 to 100." });
    expect(findOrganiserEventRequests).not.toHaveBeenCalled();
  });

  test("[TC-LOGIN-004] should_return_403_when_attendee_lists_organiser_requests", async () => {
    signedInAs("ATTENDEE");

    const res = await getWithToken("/api/events/mine");

    expect(res.status).toBe(403);
    expect(findOrganiserEventRequests).not.toHaveBeenCalled();
  });

  test.each(["COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT"])(
    "[TC-AUTH-020] should_return_403_when_%s_lists_organiser_requests",
    async (role) => {
      signedInAs(role);

      const res = await getWithToken("/api/events/mine");

      expect(res.status).toBe(403);
      expect(findOrganiserEventRequests).not.toHaveBeenCalled();
    },
  );

  test("[TC-AUTH-023] should_leave_the_discovery_path_unclaimed_when_get_events_is_requested", async () => {
    signedInAs("ORGANISER");

    const res = await getWithToken("/api/events");

    expect(res.status).toBe(404);
  });

  test("[TC-AUTH-018] should_return_generic_500_when_organiser_event_query_fails", async () => {
    signedInAs("ORGANISER");
    findOrganiserEventRequests.mockRejectedValue(new Error("[Supabase Error] relation detail"));

    const res = await getWithToken("/api/events/mine");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("GET /api/registrations/mine", () => {
  test("[TC-AUTH-016] should_use_authenticated_attendee_id_when_query_supplies_another_id", async () => {
    signedInAs("ATTENDEE");
    findAttendeeRegistrations.mockResolvedValue({ registrations: [], nextOffset: null });

    const res = await getWithToken("/api/registrations/mine?attendee_id=999");

    expect(res.status).toBe(200);
    expect(res.body.page).toEqual({ limit: 50, offset: 0, next_offset: null });
    expect(findAttendeeRegistrations).toHaveBeenCalledWith(11, { limit: 50, offset: 0 });
  });

  test("[TC-AUTH-017] should_return_403_when_organiser_lists_attendee_registrations", async () => {
    signedInAs("ORGANISER");

    const res = await getWithToken("/api/registrations/mine");

    expect(res.status).toBe(403);
  });

  test("[TC-AUTH-018] should_return_generic_500_when_attendee_registration_query_fails", async () => {
    signedInAs("ATTENDEE");
    findAttendeeRegistrations.mockRejectedValue(new Error("[Supabase Error] relation detail"));

    const res = await getWithToken("/api/registrations/mine");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("[TC-AUTH-024] CORS", () => {
  test("should_allow_the_configured_frontend_origin_when_browser_calls_the_api", async () => {
    const res = await request(app).options("/api/auth/me")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "authorization");

    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  test("should_not_allow_other_origins_when_browser_calls_the_api", async () => {
    const res = await request(app).options("/api/auth/me")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});
