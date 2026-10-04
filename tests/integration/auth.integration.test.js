// Runs against the shared Supabase development project from .env.
// Creates namespaced synthetic accounts/data and removes them afterwards.
const request = require("supertest");
const app = require("../../server");
const { createSessionClient } = require("../../config/supabase");
const { createAuthFixtures, cleanupAuthFixtures } = require("../fixtures/authFixtures");

jest.setTimeout(120000);

let fixtures;

const login = (account, password = account.password) =>
  request(app).post("/api/auth/login").send({ email: account.email, password });

const tokenFor = async (key) => {
  const res = await login(fixtures.accounts[key]);
  expect(res.status).toBe(200);
  return res.body.session;
};

beforeAll(async () => {
  fixtures = await createAuthFixtures();
});

afterAll(async () => {
  if (fixtures) {
    await cleanupAuthFixtures(fixtures.runId);
  }
});

describe("login", () => {
  test.each([
    ["coordinator", "COORDINATOR", "/dashboard"],
    ["venueStaff", "VENUE_STAFF", "/dashboard"],
    ["techSupport", "TECH_SUPPORT", "/dashboard"],
    ["organiserA", "ORGANISER", "/dashboard"],
    ["attendee", "ATTENDEE", "/my-registrations"],
  ])("TC-LOGIN-001..005: %s signs in with the role from the database", async (key, role, homePath) => {
    const res = await login(fixtures.accounts[key]);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual(expect.objectContaining({ role, home_path: homePath, user_id: fixtures.accounts[key].userId }));
    expect(res.body.session.access_token).toEqual(expect.any(String));
    expect(res.body.session.refresh_token).toEqual(expect.any(String));
  });

  test("TC-LOGIN-006/007: unknown email and wrong password are indistinguishable", async () => {
    const unknownAccount = await login({ email: `spm32-${fixtures.runId}-nobody@connectsphere.test`, password: "Whatever-123" });
    const wrongPassword = await login(fixtures.accounts.coordinator, "Wrong-password-123");

    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownAccount.body);
    expect(unknownAccount.body).toEqual({ error: "Invalid email or password.", code: "INVALID_CREDENTIALS" });
  });

  test("an inactive profile or an Auth account without a profile gets the same generic error", async () => {
    const inactive = await login(fixtures.accounts.inactive);
    const unlinked = await login(fixtures.accounts.unlinked);

    expect(inactive.status).toBe(401);
    expect(inactive.body.code).toBe("INVALID_CREDENTIALS");
    expect(unlinked.status).toBe(401);
    expect(unlinked.body.code).toBe("INVALID_CREDENTIALS");
  });

  test("TC-LOGIN-010: blank fields are rejected with field messages", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: " ", password: "" });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ email: "Email is required.", password: "Password is required." });
  });
});

describe("data scoping", () => {
  test("TC-LOGIN-005: an organiser sees own requests and submitted same-organisation requests only", async () => {
    const session = await tokenFor("organiserA");
    const res = await request(app).get("/api/events").set("Authorization", `Bearer ${session.access_token}`);

    expect(res.status).toBe(200);
    const byId = new Map(res.body.events.map((event) => [event.event_id, event]));
    const { events } = fixtures;

    expect(byId.get(events.ownSubmitted).is_owner).toBe(true);
    expect(byId.get(events.ownDraft).is_owner).toBe(true);
    expect(byId.get(events.colleagueSubmitted).is_owner).toBe(false);
    expect(byId.has(events.colleagueDraft)).toBe(false);
    expect(byId.has(events.otherOrganisation)).toBe(false);
    expect(byId.has(events.registeredConfirmed)).toBe(false);
    expect(byId.get(events.ownSubmitted)).not.toHaveProperty("organiser_id");
  });

  test("TC-LOGIN-004: an attendee sees only their active registrations, in attendee-safe form", async () => {
    const session = await tokenFor("attendee");
    const res = await request(app).get("/api/registrations/mine").set("Authorization", `Bearer ${session.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.registrations).toHaveLength(1);
    const [registration] = res.body.registrations;
    expect(registration.registration_status).toBe("REGISTERED");
    expect(registration.event.event_id).toBe(fixtures.events.registeredConfirmed);
    expect(registration.event.status).toBe("CONFIRMED");
    expect(registration.event).not.toHaveProperty("coordinator_id");
    expect(registration.event).not.toHaveProperty("organiser_id");
  });

  test("TC-LOGIN-004: an attendee cannot read organiser planning data", async () => {
    const session = await tokenFor("attendee");
    const res = await request(app).get("/api/events").set("Authorization", `Bearer ${session.access_token}`);
    expect(res.status).toBe(403);
  });
});

describe("protected access and logout", () => {
  test("TC-LOGIN-011: protected routes reject a missing token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  test("TC-LOGIN-013: logout revokes the access and refresh tokens immediately", async () => {
    const session = await tokenFor("venueStaff");
    const auth = `Bearer ${session.access_token}`;

    const before = await request(app).get("/api/auth/me").set("Authorization", auth);
    expect(before.status).toBe(200);

    const logout = await request(app).post("/api/auth/logout").set("Authorization", auth);
    expect(logout.status).toBe(204);

    const after = await request(app).get("/api/auth/me").set("Authorization", auth);
    expect(after.status).toBe(401);

    const { error } = await createSessionClient().auth.refreshSession({ refresh_token: session.refresh_token });
    expect(error).toBeTruthy();

    const repeatLogout = await request(app).post("/api/auth/logout").set("Authorization", auth);
    expect(repeatLogout.status).toBe(204);
  });

  test("logout leaves the user's other sessions signed in", async () => {
    const first = await tokenFor("techSupport");
    const second = await tokenFor("techSupport");

    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${first.access_token}`);

    const other = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${second.access_token}`);
    expect(other.status).toBe(200);
  });
});
