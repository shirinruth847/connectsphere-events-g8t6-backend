// SPM-32 live integration tests: real Express routes, middleware, Supabase
// Auth and the shared development database from .env. Nothing is mocked.
// Fixtures are synthetic, namespaced by run ID and removed afterwards.
const request = require("supertest");
const app = require("../../server");
const { createSessionClient } = require("../../config/supabase");
const {
  newRunId,
  createAuthFixtures,
  cleanupAuthFixtures,
  setFixtureProfileActive,
  countFixtureActivity,
} = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const GENERIC_LOGIN_ERROR = { error: "Invalid email or password.", code: "INVALID_CREDENTIALS" };
const ATTENDEE_EVENT_KEYS = ["description", "end_datetime", "event_id", "start_datetime", "status", "title", "venue"];

const runId = newRunId();
let fixtures;

const login = (account, password = account.password) =>
  request(app).post("/api/auth/login").send({ email: account.email, password });

// Supabase Auth rate-limits password sign-ins per IP, so read-only checks
// share one login per role. Tests that revoke or alter a session use
// freshSignIn so they never invalidate a shared session.
const loginResponses = new Map();

const loginResponseFor = async (key) => {
  if (!loginResponses.has(key)) {
    loginResponses.set(key, login(fixtures.accounts[key]));
  }
  return loginResponses.get(key);
};

const assertSignedIn = (key, res) => {
  if (res.status !== 200) {
    throw new Error(`Sign-in for ${key} failed with ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.session;
};

const signIn = async (key) => assertSignedIn(key, await loginResponseFor(key));

const freshSignIn = async (key) => assertSignedIn(key, await login(fixtures.accounts[key]));

const bearer = (session) => `Bearer ${session.access_token}`;

const getAs = (path, session) => request(app).get(path).set("Authorization", bearer(session));

// Same header and signature, but a payload claiming a different identity/role.
const tamperPayload = (accessToken) => {
  const [header, payload, signature] = accessToken.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const forged = { ...claims, role: "service_role", user_role: "COORDINATOR" };
  return [header, Buffer.from(JSON.stringify(forged)).toString("base64url"), signature].join(".");
};

beforeAll(async () => {
  fixtures = await createAuthFixtures(runId);
});

// Runs even when setup fails part-way, using the manifest written so far.
afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("POST /api/auth/login", () => {
  test.each([
    ["TC-LOGIN-001", "coordinator", "COORDINATOR", "/dashboard"],
    ["TC-LOGIN-002", "venueStaff", "VENUE_STAFF", "/dashboard"],
    ["TC-LOGIN-003", "techSupport", "TECH_SUPPORT", "/dashboard"],
    ["TC-LOGIN-004", "attendee", "ATTENDEE", "/my-registrations"],
    ["TC-LOGIN-005", "organiserA", "ORGANISER", "/dashboard"],
  ])("[%s] should_return_session_and_role_home_path_when_%s_signs_in_with_valid_credentials", async (_id, key, role, homePath) => {
    const account = fixtures.accounts[key];

    const res = await loginResponseFor(key);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.user).toEqual({
      user_id: account.userId,
      email: account.email,
      name: `spm32 ${key}`,
      role,
      home_path: homePath,
    });
    expect(res.body.session).toEqual(expect.objectContaining({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      token_type: "bearer",
    }));
  });

  test("[TC-LOGIN-001..005] should_issue_a_token_accepted_by_protected_routes_when_login_succeeds", async () => {
    const session = await signIn("coordinator");

    const res = await getAs("/api/auth/me", session);

    expect(res.status).toBe(200);
    expect(res.body.user.user_id).toBe(fixtures.accounts.coordinator.userId);
  });

  test("[TC-LOGIN-006] should_return_generic_401_when_email_is_not_registered", async () => {
    const res = await login({ email: `spm32-${runId}-nobody@connectsphere.test`, password: "Any-password-123" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC_LOGIN_ERROR);
    expect(res.body.session).toBeUndefined();
  });

  test("[TC-LOGIN-007] should_return_the_same_generic_401_when_password_is_wrong", async () => {
    const res = await login(fixtures.accounts.coordinator, "Wrong-password-123");

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC_LOGIN_ERROR);
  });

  test("[TC-AUTH-001] should_return_the_same_generic_401_when_profile_is_inactive", async () => {
    const res = await login(fixtures.accounts.inactive);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC_LOGIN_ERROR);
  });

  test("[TC-AUTH-002] should_return_the_same_generic_401_when_auth_account_has_no_linked_profile", async () => {
    const res = await login(fixtures.accounts.unlinked);

    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC_LOGIN_ERROR);
  });

  test("[TC-LOGIN-008] should_return_400_with_email_field_error_when_email_is_blank", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "   ", password: "Any-password-123" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.fields).toEqual({ email: "Email is required." });
  });

  test("[TC-LOGIN-009] should_return_400_with_password_field_error_when_password_is_blank", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: fixtures.accounts.coordinator.email, password: "" });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ password: "Password is required." });
  });

  test("[TC-LOGIN-010] should_return_400_with_both_field_errors_when_both_fields_are_missing", async () => {
    const res = await request(app).post("/api/auth/login").send({});

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ email: "Email is required.", password: "Password is required." });
  });

  test("[TC-AUTH-003] should_reject_login_when_client_supplies_a_role", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: fixtures.accounts.attendee.email, password: fixtures.accounts.attendee.password, role: "COORDINATOR" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNKNOWN_FIELDS");
    expect(res.body.session).toBeUndefined();
  });

  test("[TC-AUTH-004] should_not_write_activity_records_when_users_log_in", async () => {
    const before = await countFixtureActivity(fixtures);

    await freshSignIn("organiserB");
    await login(fixtures.accounts.organiserB, "Wrong-password-123");

    expect(await countFixtureActivity(fixtures)).toBe(before);
  });
});

describe("GET /api/auth/me", () => {
  test("[TC-LOGIN-011] should_return_401_when_no_token_is_sent", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Please log in to continue.", code: "UNAUTHENTICATED" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test.each([
    ["not a JWT", "Bearer not-a-real-token"],
    ["wrong scheme", "Basic dXNlcjpwYXNz"],
    ["empty bearer", "Bearer "],
  ])("[TC-AUTH-005] should_return_401_when_authorization_header_is_%s", async (_label, header) => {
    const res = await request(app).get("/api/auth/me").set("Authorization", header);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  test("[TC-AUTH-006] should_return_401_when_token_claims_are_tampered", async () => {
    const session = await signIn("attendee");

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tamperPayload(session.access_token)}`);

    expect(res.status).toBe(401);
  });

  test("[TC-AUTH-007] should_return_profile_from_database_with_no_store_when_token_is_valid", async () => {
    const session = await signIn("venueStaff");

    const res = await getAs("/api/auth/me", session);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.user).toEqual(expect.objectContaining({ role: "VENUE_STAFF", home_path: "/dashboard" }));
  });

  test("[TC-AUTH-008] should_ignore_identity_headers_and_use_the_token_owner_when_x_user_id_is_sent", async () => {
    const session = await signIn("attendee");

    const res = await getAs("/api/auth/me", session)
      .set("X-User-ID", String(fixtures.accounts.coordinator.userId))
      .set("X-User-Role", "COORDINATOR");

    expect(res.status).toBe(200);
    expect(res.body.user.user_id).toBe(fixtures.accounts.attendee.userId);
    expect(res.body.user.role).toBe("ATTENDEE");
  });

  test("[TC-AUTH-009] should_return_401_when_profile_is_deactivated_after_login", async () => {
    const session = await signIn("deactivatable");
    expect((await getAs("/api/auth/me", session)).status).toBe(200);

    await setFixtureProfileActive(fixtures, "deactivatable", false);
    try {
      const res = await getAs("/api/auth/me", session);
      expect(res.status).toBe(401);
    } finally {
      await setFixtureProfileActive(fixtures, "deactivatable", true);
    }
  });
});

describe("POST /api/auth/logout", () => {
  test("[TC-LOGIN-013] should_reject_the_access_token_immediately_when_user_logs_out", async () => {
    const session = await freshSignIn("venueStaff");
    expect((await getAs("/api/auth/me", session)).status).toBe(200);

    const logout = await request(app).post("/api/auth/logout").set("Authorization", bearer(session));
    const after = await getAs("/api/auth/me", session);

    expect(logout.status).toBe(204);
    expect(logout.headers["cache-control"]).toBe("no-store");
    expect(after.status).toBe(401);
  });

  test("[TC-LOGIN-013] should_reject_the_refresh_token_when_user_logs_out", async () => {
    const session = await freshSignIn("venueStaff");

    await request(app).post("/api/auth/logout").set("Authorization", bearer(session));
    const { data, error } = await createSessionClient().auth.refreshSession({ refresh_token: session.refresh_token });

    expect(error).toBeTruthy();
    expect(data.session).toBeNull();
  });

  test("[TC-LOGIN-013] should_return_204_when_logout_is_repeated_with_a_revoked_token", async () => {
    const session = await freshSignIn("venueStaff");
    await request(app).post("/api/auth/logout").set("Authorization", bearer(session));

    const repeat = await request(app).post("/api/auth/logout").set("Authorization", bearer(session));

    expect(repeat.status).toBe(204);
  });

  test("[TC-AUTH-010] should_return_204_when_logout_has_no_token", async () => {
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(204);
  });

  test("[TC-AUTH-011] should_keep_other_sessions_valid_when_one_session_logs_out", async () => {
    const first = await freshSignIn("techSupport");
    const second = await signIn("techSupport");

    await request(app).post("/api/auth/logout").set("Authorization", bearer(first));

    expect((await getAs("/api/auth/me", first)).status).toBe(401);
    expect((await getAs("/api/auth/me", second)).status).toBe(200);
  });

  test("[TC-AUTH-012] should_revoke_only_the_targeted_sessions_when_parallel_sessions_log_out_concurrently", async () => {
    const sessions = await Promise.all([1, 2, 3].map(() => freshSignIn("organiserSolo")));
    const [kept, ...revoked] = sessions;

    const logouts = await Promise.all(
      revoked.map((session) => request(app).post("/api/auth/logout").set("Authorization", bearer(session))),
    );
    const checks = await Promise.all(sessions.map((session) => getAs("/api/auth/me", session)));

    expect(logouts.map((res) => res.status)).toEqual([204, 204]);
    expect(checks.map((res) => res.status)).toEqual([200, 401, 401]);
    expect(new Set(sessions.map((session) => session.access_token)).size).toBe(3);
  });
});

describe("GET /api/events (organiser data scoping)", () => {
  const listEventsAs = async (key) => {
    const res = await getAs("/api/events", await signIn(key));
    return { res, byId: new Map((res.body.events || []).map((event) => [event.event_id, event])) };
  };

  test("[TC-LOGIN-005] should_list_own_requests_in_any_state_when_organiser_views_dashboard", async () => {
    const { res, byId } = await listEventsAs("organiserA");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(byId.get(fixtures.events.ownSubmitted)).toEqual(expect.objectContaining({ status: "SUBMITTED", is_owner: true }));
    expect(byId.get(fixtures.events.ownDraft)).toEqual(expect.objectContaining({ status: "DRAFT", is_owner: true }));
  });

  test("[TC-LOGIN-005] should_list_submitted_same_organisation_requests_when_organiser_belongs_to_the_organisation", async () => {
    const { byId } = await listEventsAs("organiserA");

    expect(byId.get(fixtures.events.colleagueSubmitted)).toEqual(expect.objectContaining({
      is_owner: false,
      organisation: { organisation_id: fixtures.organisations.A, name: `spm32-${runId} Organisation A` },
    }));
  });

  test("[TC-AUTH-013] should_hide_a_colleagues_draft_when_it_belongs_to_the_same_organisation", async () => {
    const { byId } = await listEventsAs("organiserA");

    expect(byId.has(fixtures.events.colleagueDraft)).toBe(false);
  });

  test("[TC-LOGIN-005] should_hide_other_organisation_requests_when_organiser_is_not_a_member", async () => {
    const { byId } = await listEventsAs("organiserA");

    expect(byId.has(fixtures.events.otherOrganisation)).toBe(false);
    expect(byId.has(fixtures.events.registeredConfirmed)).toBe(false);
    expect(byId.has(fixtures.events.soloSubmitted)).toBe(false);
  });

  test("[TC-LOGIN-005] should_hide_organisation_A_requests_when_organiser_belongs_to_organisation_B", async () => {
    const { byId } = await listEventsAs("organiserB");

    expect(byId.has(fixtures.events.otherOrganisation)).toBe(true);
    expect(byId.has(fixtures.events.ownSubmitted)).toBe(false);
    expect(byId.has(fixtures.events.colleagueSubmitted)).toBe(false);
  });

  test("[TC-AUTH-014] should_list_only_own_requests_when_organiser_has_no_organisation", async () => {
    const { byId } = await listEventsAs("organiserSolo");

    expect(byId.has(fixtures.events.soloSubmitted)).toBe(true);
    for (const [key, eventId] of Object.entries(fixtures.events)) {
      if (key !== "soloSubmitted") {
        expect(byId.has(eventId)).toBe(false);
      }
    }
  });

  test("[TC-AUTH-015] should_not_expose_organiser_identity_or_internal_fields_when_listing_requests", async () => {
    const { byId } = await listEventsAs("organiserA");
    const colleagueEvent = byId.get(fixtures.events.colleagueSubmitted);

    expect(colleagueEvent).not.toHaveProperty("organiser_id");
    expect(colleagueEvent).not.toHaveProperty("coordinator_id");
    expect(colleagueEvent).not.toHaveProperty("purpose");
  });

  test.each(["attendee", "coordinator", "venueStaff", "techSupport"])(
    "[TC-LOGIN-004] should_return_403_when_%s_requests_organiser_event_list",
    async (key) => {
      const res = await getAs("/api/events", await signIn(key));

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "You do not have permission to access this resource.", code: "FORBIDDEN" });
    },
  );

  test("[TC-LOGIN-011] should_return_401_when_event_list_is_requested_without_a_token", async () => {
    const res = await request(app).get("/api/events");

    expect(res.status).toBe(401);
  });
});

describe("GET /api/registrations/mine (attendee data scoping)", () => {
  const listRegistrationsAs = async (key, path = "/api/registrations/mine") => {
    const res = await getAs(path, await signIn(key));
    return { res, byEvent: new Map((res.body.registrations || []).map((item) => [item.event.event_id, item])) };
  };

  test("[TC-LOGIN-004] should_list_registered_and_waitlisted_events_when_attendee_views_registrations", async () => {
    const { res, byEvent } = await listRegistrationsAs("attendee");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.registrations).toHaveLength(2);
    expect(byEvent.get(fixtures.events.registeredConfirmed).registration_status).toBe("REGISTERED");
    expect(byEvent.get(fixtures.events.registeredPlanning).registration_status).toBe("WAITLISTED");
  });

  test("[TC-REG-001] should_exclude_withdrawn_registrations_when_attendee_views_registrations", async () => {
    const { byEvent } = await listRegistrationsAs("attendee");

    expect(byEvent.has(fixtures.events.ownSubmitted)).toBe(false);
  });

  test("[TC-LOGIN-004] should_return_only_attendee_safe_event_fields_when_attendee_views_registrations", async () => {
    const { res } = await listRegistrationsAs("attendee");

    for (const registration of res.body.registrations) {
      expect(Object.keys(registration.event).sort()).toEqual(ATTENDEE_EVENT_KEYS);
    }
  });

  test("[TC-REG-002] should_show_the_approved_venue_when_registered_event_is_confirmed", async () => {
    const { byEvent } = await listRegistrationsAs("attendee");
    const { event } = byEvent.get(fixtures.events.registeredConfirmed);

    expect(event.status).toBe("CONFIRMED");
    expect(event.venue).toEqual({ name: `spm32-${runId} Hall`, address: `spm32-${runId} 1 Test Road` });
  });

  test("[TC-REG-003] should_hide_planning_status_and_provisional_venue_when_registered_event_is_not_confirmed", async () => {
    const { byEvent } = await listRegistrationsAs("attendee");
    const { event } = byEvent.get(fixtures.events.registeredPlanning);

    expect(event.status).toBe("PENDING_CONFIRMATION");
    expect(event.venue).toBeNull();
  });

  test("[TC-AUTH-016] should_ignore_attendee_id_query_and_return_own_registrations_when_attendee_requests_another_id", async () => {
    const { res } = await listRegistrationsAs(
      "deactivatable",
      `/api/registrations/mine?attendee_id=${fixtures.accounts.attendee.userId}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.registrations).toEqual([]);
  });

  test.each(["organiserA", "coordinator", "venueStaff", "techSupport"])(
    "[TC-AUTH-017] should_return_403_when_%s_requests_attendee_registrations",
    async (key) => {
      const res = await getAs("/api/registrations/mine", await signIn(key));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    },
  );

  test("[TC-LOGIN-011] should_return_401_when_registrations_are_requested_without_a_token", async () => {
    const res = await request(app).get("/api/registrations/mine");

    expect(res.status).toBe(401);
  });
});
