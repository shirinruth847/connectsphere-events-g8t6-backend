jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel");
jest.mock("../../model/registrationModel");

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const { findOrganiserEventRequests } = require("../../model/eventModel");
const { findAttendeeRegistrations } = require("../../model/registrationModel");

const session = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 1790000000,
  user: { id: "auth-uuid" },
};

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

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/auth/login", () => {
  test.each([
    ["COORDINATOR", "/dashboard"],
    ["VENUE_STAFF", "/dashboard"],
    ["TECH_SUPPORT", "/dashboard"],
    ["ORGANISER", "/dashboard"],
    ["ATTENDEE", "/my-registrations"],
  ])("[TC-LOGIN-001..005] should_return_home_path_when_%s_signs_in", async (role, homePath) => {
    userModel.authenticateWithPassword.mockResolvedValue(session);
    userModel.findUserByAuthId.mockResolvedValue(profileFor(role));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: ` ${role.toLowerCase()}@connectsphere.test `, password: "pw" });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.user).toEqual(expect.objectContaining({ role, home_path: homePath }));
    expect(res.body.session).toEqual(expect.objectContaining({ access_token: "access-token", refresh_token: "refresh-token" }));
    expect(userModel.authenticateWithPassword).toHaveBeenCalledWith(`${role.toLowerCase()}@connectsphere.test`, "pw");
  });

  test("[TC-LOGIN-006/007] should_return_identical_401_when_email_is_unknown_or_password_is_wrong", async () => {
    userModel.authenticateWithPassword.mockResolvedValue(null);

    const unknownAccount = await request(app).post("/api/auth/login").send({ email: "nobody@connectsphere.test", password: "pw" });
    const wrongPassword = await request(app).post("/api/auth/login").send({ email: "ec@connectsphere.test", password: "bad" });

    expect(unknownAccount.status).toBe(401);
    expect(unknownAccount.body).toEqual({ error: "Invalid email or password.", code: "INVALID_CREDENTIALS" });
    expect(wrongPassword.status).toBe(unknownAccount.status);
    expect(wrongPassword.body).toEqual(unknownAccount.body);
  });

  test("[TC-AUTH-001/002] should_revoke_new_session_and_return_generic_401_when_no_active_profile_exists", async () => {
    userModel.authenticateWithPassword.mockResolvedValue(session);
    userModel.findUserByAuthId.mockResolvedValue(null);

    const res = await request(app).post("/api/auth/login").send({ email: "inactive@connectsphere.test", password: "pw" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_CREDENTIALS");
    expect(res.body.session).toBeUndefined();
    expect(userModel.revokeSession).toHaveBeenCalledWith("access-token");
  });

  test("[TC-LOGIN-010] should_not_contact_supabase_when_fields_are_blank", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "", password: "" });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields)).toEqual(["email", "password"]);
    expect(userModel.authenticateWithPassword).not.toHaveBeenCalled();
  });

  test("[TC-AUTH-019] should_return_429_when_supabase_rate_limits_sign_in", async () => {
    const rateLimited = new Error("rate limited");
    rateLimited.code = "AUTH_RATE_LIMITED";
    userModel.authenticateWithPassword.mockRejectedValue(rateLimited);

    const res = await request(app).post("/api/auth/login").send({ email: "a@connectsphere.test", password: "pw" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  test("[TC-AUTH-018] should_hide_internal_detail_when_login_fails_unexpectedly", async () => {
    userModel.authenticateWithPassword.mockRejectedValue(new Error("[Supabase Auth Error] 500 secret detail"));

    const res = await request(app).post("/api/auth/login").send({ email: "a@connectsphere.test", password: "pw" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });

  test("[TC-AUTH-018] should_return_400_when_json_is_malformed", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{\"email\":");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
  });
});

describe("GET /api/auth/me", () => {
  test("[TC-LOGIN-011] should_return_401_with_no_store_when_token_is_missing", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("[TC-LOGIN-013] should_return_401_when_token_is_rejected_or_revoked", async () => {
    userModel.verifyAccessToken.mockResolvedValue(null);
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer revoked");
    expect(res.status).toBe(401);
  });

  test("[TC-AUTH-009] should_return_401_when_auth_user_has_no_active_profile", async () => {
    userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
    userModel.findUserByAuthId.mockResolvedValue(null);
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer token");
    expect(res.status).toBe(401);
  });

  test("[TC-AUTH-007] should_return_database_profile_when_token_is_valid", async () => {
    signedInAs("VENUE_STAFF");
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(expect.objectContaining({ role: "VENUE_STAFF", home_path: "/dashboard" }));
    expect(userModel.verifyAccessToken).toHaveBeenCalledWith("token");
  });

  test("[TC-AUTH-018] should_return_500_when_supabase_auth_is_unavailable", async () => {
    userModel.verifyAccessToken.mockRejectedValue(new Error("[Supabase Auth Error] 503"));
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer token");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });
});

describe("POST /api/auth/logout", () => {
  test("[TC-LOGIN-013] should_revoke_presented_session_when_logging_out", async () => {
    const res = await request(app).post("/api/auth/logout").set("Authorization", "Bearer token");
    expect(res.status).toBe(204);
    expect(userModel.revokeSession).toHaveBeenCalledWith("token");
  });

  test("[TC-AUTH-010] should_return_204_when_logout_has_no_token", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(204);
    expect(userModel.revokeSession).not.toHaveBeenCalled();
  });
});

describe("role-scoped routes", () => {
  test("[TC-LOGIN-005] should_return_scoped_requests_when_organiser_lists_events", async () => {
    signedInAs("ORGANISER");
    findOrganiserEventRequests.mockResolvedValue([{ event_id: 1, is_owner: true }]);

    const res = await request(app).get("/api/events").set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(findOrganiserEventRequests).toHaveBeenCalledWith(expect.objectContaining({ user_id: 11 }));
  });

  test.each(["ATTENDEE", "COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT"])(
    "[TC-LOGIN-004] should_return_403_when_%s_lists_events",
    async (role) => {
      signedInAs(role);
      const res = await request(app).get("/api/events").set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
      expect(findOrganiserEventRequests).not.toHaveBeenCalled();
    },
  );

  test("[TC-AUTH-016] should_use_authenticated_attendee_id_when_query_supplies_another_id", async () => {
    signedInAs("ATTENDEE");
    findAttendeeRegistrations.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/registrations/mine?attendee_id=999")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(findAttendeeRegistrations).toHaveBeenCalledWith(11);
  });

  test("[TC-AUTH-017] should_return_403_when_organiser_lists_attendee_registrations", async () => {
    signedInAs("ORGANISER");
    const res = await request(app).get("/api/registrations/mine").set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });
});

describe("[TC-AUTH-018] safe failures", () => {
  test("should_return_generic_500_when_organiser_event_query_fails", async () => {
    signedInAs("ORGANISER");
    findOrganiserEventRequests.mockRejectedValue(new Error("[Supabase Error] relation detail"));

    const res = await request(app).get("/api/events").set("Authorization", "Bearer token");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });

  test("should_return_generic_500_when_attendee_registration_query_fails", async () => {
    signedInAs("ATTENDEE");
    findAttendeeRegistrations.mockRejectedValue(new Error("[Supabase Error] relation detail"));

    const res = await request(app).get("/api/registrations/mine").set("Authorization", "Bearer token");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });

  test("should_return_generic_500_when_session_revocation_fails", async () => {
    userModel.revokeSession.mockRejectedValue(new Error("[Supabase Auth Error] 500"));

    const res = await request(app).post("/api/auth/logout").set("Authorization", "Bearer token");

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });
});
