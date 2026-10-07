// SPM-32 live integration tests: real Express routes, middleware, Supabase
// Auth and the shared development database from .env. Nothing is mocked.
// Users sign in directly with Supabase Auth, as the browser does, and the
// resulting token is sent to the backend. Fixtures are synthetic, namespaced
// by run ID and removed afterwards.
const request = require("supertest");
const app = require("../../server");
const { createBrowserAuthClient, signInWithPassword } = require("../fixtures/browserAuthClient");
const {
  newRunId,
  createAuthFixtures,
  cleanupAuthFixtures,
  setFixtureProfileActive,
  countFixtureActivity,
} = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const ATTENDEE_EVENT_KEYS = ["attendee_status", "description", "end_datetime", "event_id", "start_datetime", "title", "venue"];

const runId = newRunId();
let fixtures;

// Supabase Auth rate-limits password sign-ins per IP, so read-only checks
// share one sign-in per role. Tests that revoke or alter a session use
// freshSignIn so they never invalidate a shared session.
const sharedSignIns = new Map();

const assertSignedIn = (key, { session, error }) => {
  if (error || !session) {
    throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
  }
  return session;
};

const freshSignIn = async (key) => {
  const account = fixtures.accounts[key];
  return assertSignedIn(key, await signInWithPassword(account.email, account.password));
};

const signIn = async (key) => {
  if (!sharedSignIns.has(key)) {
    sharedSignIns.set(key, freshSignIn(key));
  }
  return sharedSignIns.get(key);
};

const bearer = (session) => `Bearer ${session.access_token}`;

const getAs = (path, session) => request(app).get(path).set("Authorization", bearer(session));

const logoutAs = (session) => request(app).post("/api/auth/logout").set("Authorization", bearer(session));

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

describe("Sign-in with Supabase Auth, then GET /api/auth/me", () => {
  test.each([
    ["TC-LOGIN-001", "coordinator", "COORDINATOR", "/dashboard"],
    ["TC-LOGIN-002", "venueStaff", "VENUE_STAFF", "/dashboard"],
    ["TC-LOGIN-003", "techSupport", "TECH_SUPPORT", "/dashboard"],
    ["TC-LOGIN-004", "attendee", "ATTENDEE", "/my-registrations"],
    ["TC-LOGIN-005", "organiserA", "ORGANISER", "/dashboard"],
  ])("[%s] should_return_database_role_and_home_path_when_%s_signs_in_with_valid_credentials", async (_id, key, role, homePath) => {
    const account = fixtures.accounts[key];
    const session = await signIn(key);

    const res = await getAs("/api/auth/me", session);

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.user).toEqual({
      user_id: account.userId,
      email: account.email,
      name: `spm32 ${key}`,
      role,
      roles: [role],
      home_path: homePath,
    });
  });

  test("[TC-LOGIN-006/007] should_return_identical_supabase_errors_when_email_is_unknown_or_password_is_wrong", async () => {
    const unknownEmail = await signInWithPassword(`spm32-${runId}-nobody@connectsphere.test`, "Any-password-123");
    const wrongPassword = await signInWithPassword(fixtures.accounts.coordinator.email, "Wrong-password-123");

    expect(unknownEmail.session).toBeNull();
    expect(wrongPassword.session).toBeNull();
    expect({ status: wrongPassword.error.status, code: wrongPassword.error.code, message: wrongPassword.error.message })
      .toEqual({ status: unknownEmail.error.status, code: unknownEmail.error.code, message: unknownEmail.error.message });
    expect(unknownEmail.error.code).toBe("invalid_credentials");
  });

  test("[TC-AUTH-001] should_return_401_from_me_when_profile_is_inactive", async () => {
    const session = await freshSignIn("inactive");

    const res = await getAs("/api/auth/me", session);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Please log in to continue.", code: "UNAUTHENTICATED" });
  });

  test("[TC-AUTH-002] should_return_401_from_me_when_auth_account_has_no_linked_profile", async () => {
    const session = await freshSignIn("unlinked");

    const res = await getAs("/api/auth/me", session);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  test("[TC-AUTH-004] should_not_write_activity_records_when_users_load_their_profile_and_log_out", async () => {
    const before = await countFixtureActivity(fixtures);
    const session = await freshSignIn("organiserB");

    await getAs("/api/auth/me", session);
    await logoutAs(session);

    expect(await countFixtureActivity(fixtures)).toBe(before);
  });

  test("[TC-AUTH-022] should_return_404_when_backend_login_is_requested", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: fixtures.accounts.coordinator.email, password: fixtures.accounts.coordinator.password });

    expect(res.status).toBe(404);
  });
});

describe("GET /api/auth/me token checks", () => {
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

  test("[TC-AUTH-008] should_ignore_identity_headers_and_use_the_token_owner_when_x_user_id_is_sent", async () => {
    const session = await signIn("attendee");

    const res = await getAs("/api/auth/me", session)
      .set("X-User-ID", String(fixtures.accounts.coordinator.userId))
      .set("X-User-Role", "COORDINATOR");

    expect(res.status).toBe(200);
    expect(res.body.user.user_id).toBe(fixtures.accounts.attendee.userId);
    expect(res.body.user.roles).toEqual(["ATTENDEE"]);
  });

  test("[TC-AUTH-009] should_return_401_when_profile_is_deactivated_after_sign_in", async () => {
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

    const logout = await logoutAs(session);
    const after = await getAs("/api/auth/me", session);

    expect(logout.status).toBe(204);
    expect(logout.headers["cache-control"]).toBe("no-store");
    expect(after.status).toBe(401);
  });

  test("[TC-LOGIN-013] should_reject_the_refresh_token_when_user_logs_out", async () => {
    const session = await freshSignIn("venueStaff");

    await logoutAs(session);
    const { data, error } = await createBrowserAuthClient().auth.refreshSession({ refresh_token: session.refresh_token });

    expect(error).toBeTruthy();
    expect(data.session).toBeNull();
  });

  test("[TC-LOGIN-013] should_return_204_when_logout_is_repeated_with_a_revoked_token", async () => {
    const session = await freshSignIn("venueStaff");
    await logoutAs(session);

    const repeat = await logoutAs(session);

    expect(repeat.status).toBe(204);
  });

  test("[TC-AUTH-010] should_return_204_when_logout_has_no_token", async () => {
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(204);
  });

  test("[TC-AUTH-011] should_keep_other_sessions_valid_when_one_session_logs_out", async () => {
    const first = await freshSignIn("techSupport");
    const second = await signIn("techSupport");

    await logoutAs(first);

    expect((await getAs("/api/auth/me", first)).status).toBe(401);
    expect((await getAs("/api/auth/me", second)).status).toBe(200);
  });

  test("[TC-AUTH-012] should_revoke_only_the_targeted_sessions_when_parallel_sessions_log_out_concurrently", async () => {
    const sessions = await Promise.all([1, 2, 3].map(() => freshSignIn("organiserSolo")));
    const [kept, ...revoked] = sessions;

    const logouts = await Promise.all(revoked.map(logoutAs));
    const checks = await Promise.all(sessions.map((session) => getAs("/api/auth/me", session)));

    expect(logouts.map((res) => res.status)).toEqual([204, 204]);
    expect(checks.map((res) => res.status)).toEqual([200, 401, 401]);
    expect(new Set(sessions.map((session) => session.access_token)).size).toBe(3);
    expect(kept.access_token).toEqual(expect.any(String));
  });
});

describe("GET /api/events/mine (organiser data scoping)", () => {
  const listEventsAs = async (key, query = "") => {
    const res = await getAs(`/api/events/mine${query}`, await signIn(key));
    return { res, byId: new Map((res.body.events || []).map((event) => [event.eventId, event])) };
  };

  test("[TC-LOGIN-005] should_list_own_requests_in_any_state_when_organiser_views_dashboard", async () => {
    const { res, byId } = await listEventsAs("organiserA");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(byId.get(fixtures.events.ownSubmitted)).toEqual(expect.objectContaining({
      status: "SUBMITTED",
      statusLabel: "Pending Approval",
      isOwner: true,
    }));
    expect(byId.get(fixtures.events.ownDraft)).toEqual(expect.objectContaining({ status: "DRAFT", statusLabel: "Draft", isOwner: true }));
  });

  test("[TC-LOGIN-005] should_list_submitted_same_organisation_requests_when_organiser_belongs_to_the_organisation", async () => {
    const { byId } = await listEventsAs("organiserA");

    expect(byId.get(fixtures.events.colleagueSubmitted)).toEqual(expect.objectContaining({
      isOwner: false,
      organisation: { organisationId: fixtures.organisations.A, name: `spm32-${runId} Organisation A` },
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

    for (const key of ["organiser_id", "organiserId", "coordinator_id", "coordinatorId", "purpose", "accessibilityNeeds"]) {
      expect(colleagueEvent).not.toHaveProperty(key);
    }
  });

  test("[TC-AUTH-021] should_return_disjoint_stable_pages_when_organiser_pages_through_requests", async () => {
    const all = await listEventsAs("organiserA");
    const allIds = all.res.body.events.map((event) => event.eventId);
    const pagedIds = [];
    let cursor = null;
    do {
      const page = await listEventsAs("organiserA", `?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.res.status).toBe(200);
      pagedIds.push(...page.res.body.events.map((event) => event.eventId));
      cursor = page.res.body.nextCursor;
    } while (cursor && pagedIds.length <= allIds.length);

    expect(allIds).toHaveLength(3);
    expect(pagedIds).toEqual(allIds);
    expect(all.res.body.nextCursor).toBeNull();
  });

  test("[TC-AUTH-021] should_return_400_when_page_limit_is_out_of_range", async () => {
    const { res } = await listEventsAs("organiserA", "?limit=0");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });

  test("[TC-LOGIN-004] should_return_403_when_attendee_requests_organiser_event_list", async () => {
    const res = await getAs("/api/events/mine", await signIn("attendee"));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "You do not have permission to access this resource.", code: "FORBIDDEN" });
  });

  test.each(["coordinator", "venueStaff", "techSupport"])(
    "[TC-AUTH-020] should_return_403_when_%s_requests_organiser_event_list",
    async (key) => {
      const res = await getAs("/api/events/mine", await signIn(key));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    },
  );

  test("[TC-LOGIN-011] should_return_401_when_event_list_is_requested_without_a_token", async () => {
    const res = await request(app).get("/api/events/mine");

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

    expect(event.attendee_status).toBe("CONFIRMED");
    expect(event.venue).toEqual({ name: `spm32-${runId} Hall`, address: `spm32-${runId} 1 Test Road` });
  });

  test("[TC-REG-003] should_hide_planning_status_and_provisional_venue_when_registered_event_is_not_confirmed", async () => {
    const { byEvent } = await listRegistrationsAs("attendee");
    const { event } = byEvent.get(fixtures.events.registeredPlanning);

    expect(event.attendee_status).toBe("PENDING_CONFIRMATION");
    expect(event).not.toHaveProperty("status");
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

  test("[TC-AUTH-021] should_page_registrations_when_attendee_sets_limit", async () => {
    const { res } = await listRegistrationsAs("attendee", "/api/registrations/mine?limit=1");

    expect(res.body.registrations).toHaveLength(1);
    expect(res.body.page).toEqual({ limit: 1, offset: 0, next_offset: 1 });
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
