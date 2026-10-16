// SPM-72 live integration tests: real Express routes, middleware, Supabase Auth
// and the shared development database from .env. Nothing is mocked.
// Users sign in directly with Supabase Auth, as the browser does, and the
// resulting token is sent to the backend. Fixtures are synthetic, namespaced
// by run ID and removed afterwards.
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const {
  newRunId,
  createAuthFixtures,
  cleanupAuthFixtures,
} = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const runId = newRunId();
let fixtures;
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) {
        throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      }
      return session;
    }));
  }
  return sessions.get(key);
};

const bearer = (session) => `Bearer ${session.access_token}`;
const getAs = (path, session) => request(app).get(path).set("Authorization", bearer(session));

// Allowed by requireRole in venueRoutes.js: COORDINATOR, COORDINATOR_LEAD, VENUE_STAFF, SAFETY_OFFICER.
// Fixtures provide coordinator, coordinatorLead, venueStaff. No safetyOfficer fixture exists.
const READ_ONLY_ROLES = ["coordinator", "coordinatorLead", "venueStaff"];
const DENIED_ROLES = ["organiserA", "attendee", "techSupport"];

beforeAll(async () => {
  fixtures = await createAuthFixtures(runId);
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("GET /api/venues (SPM-72)", () => {
  test.each([undefined, "", "Basic token", "Bearer"])(
    "[TC-AUTH-001] should_return_401_when_authorization_is_%p",
    async (authorization) => {
      const requestBuilder = request(app).get("/api/venues");
      if (authorization !== undefined) requestBuilder.set("Authorization", authorization);
      const response = await requestBuilder;
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("UNAUTHENTICATED");
    }
  );

  test.each(READ_ONLY_ROLES)(
    "[AC-VC-001] should_return_200_for_%s_with_read_only_catalogue",
    async (key) => {
      const session = await signIn(key);
      const response = await getAs("/api/venues", session);
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("venues");
      expect(response.body).toHaveProperty("detailsAvailable");
      expect(Array.isArray(response.body.venues)).toBe(true);
    }
  );

  test.each(DENIED_ROLES)(
    "[AC-VC-001] should_return_403_for_%s_without_reading_the_catalogue",
    async (key) => {
      const session = await signIn(key);
      const response = await getAs("/api/venues", session);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    }
  );

  test("[TC-VC-001] should_return_available_venues_with_expected_fields", async () => {
    const session = await signIn("coordinator");
    const response = await getAs("/api/venues", session);
    expect(response.status).toBe(200);
    expect(response.body.venues.length).toBeGreaterThanOrEqual(1);

    const venue = response.body.venues.find((v) => v.name === `spm32-${runId} Hall`);
    expect(venue).toBeDefined();
    expect(venue.venueId).toBeDefined();
    expect(venue.name).toBe(`spm32-${runId} Hall`);
    expect(venue.address).toBe(`spm32-${runId} 1 Test Road`);
    expect(venue.maxCapacity).toBe(200);
    expect(venue.rooms).toEqual(expect.arrayContaining([
      expect.objectContaining({ layoutType: "THEATRE", capacity: 200 }),
    ]));
    expect(response.body.detailsAvailable).toBe(false);
  });

  test("[TC-VC-003] should_return_only_venues_present_in_postgres_source", async () => {
    const session = await signIn("coordinator");
    const response = await getAs("/api/venues", session);
    expect(response.status).toBe(200);

    const fixtureVenueId = fixtures.venue.venueId;
    const returnedIds = response.body.venues.map((v) => v.venueId);
    expect(returnedIds).toContain(fixtureVenueId);
    expect(returnedIds).not.toContain(999999);
  });

  test("[TC-VC-004] should_mark_details_as_not_checked_when_mongodb_is_unavailable", async () => {
    const session = await signIn("coordinator");
    const response = await getAs("/api/venues", session);
    expect(response.status).toBe(200);
    expect(response.body.detailsAvailable).toBe(false);
    response.body.venues.forEach((venue) => {
      expect(venue.detailStatus).toBe("NOT_CHECKED");
      expect(venue.description).toBe("not checked");
      expect(venue.facilities).toBe("not checked");
      expect(venue.supportedLayouts).toBe("not checked");
      expect(venue.accessibilityFeatures).toBe("not checked");
    });
  });

  test("[AC-VC-002] should_not_expose_a_write_endpoint_for_venues", async () => {
    const session = await signIn("coordinator");
    const response = await request(app)
      .post("/api/venues")
      .set("Authorization", bearer(session))
      .send({ name: "No write" });
    expect(response.status).toBe(404);
  });
});
