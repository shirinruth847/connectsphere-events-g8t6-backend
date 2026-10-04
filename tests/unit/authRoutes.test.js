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
  ])("signs in a %s and returns their home path", async (role, homePath) => {
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

  // TC-LOGIN-006 and TC-LOGIN-007 must be indistinguishable.
  test("returns the same generic error for any rejected credential", async () => {
    userModel.authenticateWithPassword.mockResolvedValue(null);

    const unknownAccount = await request(app).post("/api/auth/login").send({ email: "nobody@connectsphere.test", password: "pw" });
    const wrongPassword = await request(app).post("/api/auth/login").send({ email: "ec@connectsphere.test", password: "bad" });

    expect(unknownAccount.status).toBe(401);
    expect(unknownAccount.body).toEqual({ error: "Invalid email or password.", code: "INVALID_CREDENTIALS" });
    expect(wrongPassword.status).toBe(unknownAccount.status);
    expect(wrongPassword.body).toEqual(unknownAccount.body);
  });

  test("revokes the session and answers generically when no active profile exists", async () => {
    userModel.authenticateWithPassword.mockResolvedValue(session);
    userModel.findUserByAuthId.mockResolvedValue(null);

    const res = await request(app).post("/api/auth/login").send({ email: "inactive@connectsphere.test", password: "pw" });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_CREDENTIALS");
    expect(res.body.session).toBeUndefined();
    expect(userModel.revokeSession).toHaveBeenCalledWith("access-token");
  });

  test("rejects blank fields before contacting Supabase", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "", password: "" });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields)).toEqual(["email", "password"]);
    expect(userModel.authenticateWithPassword).not.toHaveBeenCalled();
  });

  test("maps the Supabase rate limit to 429", async () => {
    const rateLimited = new Error("rate limited");
    rateLimited.code = "AUTH_RATE_LIMITED";
    userModel.authenticateWithPassword.mockRejectedValue(rateLimited);

    const res = await request(app).post("/api/auth/login").send({ email: "a@connectsphere.test", password: "pw" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  test("hides unexpected failures", async () => {
    userModel.authenticateWithPassword.mockRejectedValue(new Error("[Supabase Auth Error] 500 secret detail"));

    const res = await request(app).post("/api/auth/login").send({ email: "a@connectsphere.test", password: "pw" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });

  test("rejects malformed JSON safely", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{\"email\":");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
  });
});

describe("GET /api/auth/me", () => {
  // TC-LOGIN-011: the frontend redirects to /login on 401.
  test("returns 401 without a token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("returns 401 for a rejected or revoked token", async () => {
    userModel.verifyAccessToken.mockResolvedValue(null);
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer revoked");
    expect(res.status).toBe(401);
  });

  test("returns 401 when the Auth user has no active profile", async () => {
    userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
    userModel.findUserByAuthId.mockResolvedValue(null);
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer token");
    expect(res.status).toBe(401);
  });

  test("returns the profile loaded from the database", async () => {
    signedInAs("VENUE_STAFF");
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(expect.objectContaining({ role: "VENUE_STAFF", home_path: "/dashboard" }));
    expect(userModel.verifyAccessToken).toHaveBeenCalledWith("token");
  });

  test("passes Auth outages to the error handler as 500", async () => {
    userModel.verifyAccessToken.mockRejectedValue(new Error("[Supabase Auth Error] 503"));
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer token");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });
});

describe("POST /api/auth/logout", () => {
  test("revokes the presented session", async () => {
    const res = await request(app).post("/api/auth/logout").set("Authorization", "Bearer token");
    expect(res.status).toBe(204);
    expect(userModel.revokeSession).toHaveBeenCalledWith("token");
  });

  test("succeeds without a token", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(204);
    expect(userModel.revokeSession).not.toHaveBeenCalled();
  });
});

describe("role-scoped routes", () => {
  test("GET /api/events returns the organiser's scoped requests", async () => {
    signedInAs("ORGANISER");
    findOrganiserEventRequests.mockResolvedValue([{ event_id: 1, is_owner: true }]);

    const res = await request(app).get("/api/events").set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(findOrganiserEventRequests).toHaveBeenCalledWith(expect.objectContaining({ user_id: 11 }));
  });

  // TC-LOGIN-004: attendees cannot reach organiser/staff planning data.
  test.each(["ATTENDEE", "COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT"])(
    "GET /api/events forbids %s",
    async (role) => {
      signedInAs(role);
      const res = await request(app).get("/api/events").set("Authorization", "Bearer token");
      expect(res.status).toBe(403);
      expect(findOrganiserEventRequests).not.toHaveBeenCalled();
    },
  );

  test("GET /api/registrations/mine uses the authenticated attendee's ID", async () => {
    signedInAs("ATTENDEE");
    findAttendeeRegistrations.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/registrations/mine?attendee_id=999")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(findAttendeeRegistrations).toHaveBeenCalledWith(11);
  });

  test("GET /api/registrations/mine forbids an organiser", async () => {
    signedInAs("ORGANISER");
    const res = await request(app).get("/api/registrations/mine").set("Authorization", "Bearer token");
    expect(res.status).toBe(403);
  });
});
