// SPM-123 live integration tests: real POST /api/auth/signup, Supabase Auth and
// the shared development database. Every email is namespaced by run ID on the
// undeliverable .test domain; whatever the run created is removed afterwards.
process.env.SIGNUP_RATE_LIMIT_MAX = "1000";

const request = require("supertest");
const app = require("../../app");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const {
  newRunId,
  startFixtureManifest,
  recordFixtureIds,
  cleanupAuthFixtures,
} = require("../fixtures/authFixtures");
const { MESSAGES, PASSWORD_REQUIREMENTS } = require("../../validators/authValidator");

jest.setTimeout(120000);

const runId = newRunId();
const PASSWORD = `Spm123-${runId}9`;
const usedEmails = new Set();

const emailFor = (label) => {
  const email = `spm123-${runId}-${label}@connectsphere.test`;
  usedEmails.add(email);
  return email;
};

const signup = (payload) => request(app).post("/api/auth/signup").send(payload);

const findAuthUsersByEmail = async (emails) => {
  const wanted = new Set(emails.map((email) => email.toLowerCase()));
  const found = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    found.push(...data.users.filter((user) => wanted.has((user.email || "").toLowerCase())));
    if (data.users.length < 1000) return found;
  }
};

const findProfilesByEmail = async (emails) => {
  const { data, error } = await supabase
    .from("user")
    .select("user_id, email, name, role, auth_user_id, is_active")
    .in("email", emails.map((email) => email.toLowerCase()));
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  return data;
};

// Records everything that exists for the given emails so cleanup removes it,
// including anything a failed request may have left behind.
const recordAccountsFor = async (emails) => {
  const [authUsers, profiles] = await Promise.all([findAuthUsersByEmail(emails), findProfilesByEmail(emails)]);
  recordFixtureIds(runId, "authUserIds", authUsers.map((user) => user.id));
  recordFixtureIds(runId, "userIds", profiles.map((profile) => profile.user_id));
  return { authUsers, profiles };
};

beforeAll(() => {
  startFixtureManifest(runId);
});

afterAll(async () => {
  await recordAccountsFor([...usedEmails]);
  await cleanupAuthFixtures(runId);
});

describe("[SPM-123 AC1] successful sign-up", () => {
  test.each([
    ["ATTENDEE", "/my-registrations"],
    ["ORGANISER", "/dashboard"],
  ])("should_create_a_linked_active_%s_profile_when_details_are_valid", async (accountType, homePath) => {
    const email = emailFor(`ok-${accountType.toLowerCase()}`);

    const res = await signup({ accountType, name: `spm123 ${accountType}`, email, password: PASSWORD });
    const { authUsers, profiles } = await recordAccountsFor([email]);

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      user_id: profiles[0].user_id,
      email,
      name: `spm123 ${accountType}`,
      role: accountType,
      roles: [accountType],
      home_path: homePath,
    });
    expect(authUsers).toHaveLength(1);
    expect(profiles).toEqual([expect.objectContaining({ role: accountType, auth_user_id: authUsers[0].id, is_active: true })]);
    expect(authUsers[0].email_confirmed_at).toEqual(expect.any(String));
  });

  test("[SPM-32 regression] should_let_a_new_attendee_sign_in_and_load_their_profile_through_get_me", async () => {
    const email = emailFor("login-attendee");
    await signup({ accountType: "ATTENDEE", name: "spm123 login", email, password: PASSWORD });
    await recordAccountsFor([email]);

    const { session, error } = await signInWithPassword(email, PASSWORD);
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${session.access_token}`);
    const registrations = await request(app).get("/api/registrations/mine").set("Authorization", `Bearer ${session.access_token}`);
    const events = await request(app).get("/api/events/mine").set("Authorization", `Bearer ${session.access_token}`);
    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${session.access_token}`);

    expect(error).toBeNull();
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(expect.objectContaining({ email, role: "ATTENDEE", home_path: "/my-registrations" }));
    expect(registrations.status).toBe(200);
    expect(registrations.body.registrations).toEqual([]);
    expect(events.status).toBe(403);
  });

  test("[SPM-32 regression] should_let_a_new_organiser_sign_in_with_no_organisation_and_only_own_requests", async () => {
    const email = emailFor("login-organiser");
    const res = await signup({ accountType: "ORGANISER", name: "spm123 organiser", email, password: PASSWORD });
    await recordAccountsFor([email]);

    const { session } = await signInWithPassword(email, PASSWORD);
    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${session.access_token}`);
    const events = await request(app).get("/api/events/mine").set("Authorization", `Bearer ${session.access_token}`);
    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${session.access_token}`);
    const { count: memberships } = await supabase
      .from("organisation_membership")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", res.body.user.user_id);

    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(expect.objectContaining({ role: "ORGANISER", home_path: "/dashboard" }));
    expect(events.status).toBe(200);
    expect(events.body.events).toEqual([]);
    expect(memberships).toBe(0);
  });

  test("should_not_create_event_registrations_when_an_attendee_signs_up", async () => {
    const email = emailFor("no-registrations");
    const res = await signup({ accountType: "ATTENDEE", name: "spm123 attendee", email, password: PASSWORD });
    await recordAccountsFor([email]);

    const { count } = await supabase
      .from("registration")
      .select("registration_id", { count: "exact", head: true })
      .eq("attendee_id", res.body.user.user_id);

    expect(res.status).toBe(201);
    expect(count).toBe(0);
  });
});

describe("[SPM-123 AC2] duplicate email", () => {
  test("should_return_the_same_generic_409_when_email_is_reused_in_any_letter_case", async () => {
    const email = emailFor("dup");
    await signup({ accountType: "ATTENDEE", name: "spm123 first", email, password: PASSWORD });

    const sameCase = await signup({ accountType: "ORGANISER", name: "spm123 second", email, password: PASSWORD });
    const otherCase = await signup({ accountType: "ATTENDEE", name: "spm123 third", email: email.toUpperCase(), password: PASSWORD });
    const { authUsers, profiles } = await recordAccountsFor([email]);

    expect(sameCase.status).toBe(409);
    expect(sameCase.body).toEqual({ error: "The email cannot be used for registration.", code: "EMAIL_UNAVAILABLE" });
    expect(otherCase.body).toEqual(sameCase.body);
    expect(authUsers).toHaveLength(1);
    expect(profiles).toEqual([expect.objectContaining({ name: "spm123 first", role: "ATTENDEE" })]);
  });

  test("should_return_the_same_409_and_leave_no_auth_account_when_email_belongs_to_an_unlinked_profile", async () => {
    const email = emailFor("legacy-profile");
    const { data: legacy, error } = await supabase
      .from("user")
      .insert({ email, name: "spm123 legacy", role: "ORGANISER", is_active: true })
      .select("user_id")
      .single();
    if (error) throw new Error(`legacy profile setup failed: ${error.message}`);
    recordFixtureIds(runId, "userIds", [legacy.user_id]);

    const res = await signup({ accountType: "ATTENDEE", name: "spm123 claimant", email, password: PASSWORD });
    const { authUsers, profiles } = await recordAccountsFor([email]);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_UNAVAILABLE");
    expect(authUsers).toHaveLength(0);
    expect(profiles).toEqual([expect.objectContaining({ user_id: legacy.user_id, auth_user_id: null, role: "ORGANISER" })]);
  });
});

describe("[SPM-123 AC3-AC5] validation creates nothing", () => {
  test("[AC3] should_return_field_errors_and_create_nothing_when_required_fields_are_blank", async () => {
    const email = emailFor("blank-name");

    const res = await signup({ accountType: "ATTENDEE", name: "", email, password: "" });
    const { authUsers, profiles } = await recordAccountsFor([email]);

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ name: MESSAGES.nameRequired, password: MESSAGES.passwordRequired });
    expect(authUsers).toHaveLength(0);
    expect(profiles).toHaveLength(0);
  });

  test("[AC4] should_explain_password_requirements_and_create_nothing_when_password_is_weak", async () => {
    const email = emailFor("weak");

    const res = await signup({ accountType: "ORGANISER", name: "spm123 weak", email, password: "lettersonly" });
    const { authUsers } = await recordAccountsFor([email]);

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ password: PASSWORD_REQUIREMENTS });
    expect(authUsers).toHaveLength(0);
  });

  test("[AC5] should_return_email_format_error_when_email_is_invalid", async () => {
    const res = await signup({ accountType: "ATTENDEE", name: "spm123 bad email", email: `spm123-${runId}-bad@`, password: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ email: MESSAGES.emailInvalid });
  });

  test.each(["COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT"])(
    "[TC-AUTH-025] should_reject_%s_and_create_nothing_when_requested_at_sign_up",
    async (accountType) => {
      const email = emailFor(`staff-${accountType.toLowerCase()}`);

      const res = await signup({ accountType, name: "spm123 staff", email, password: PASSWORD });
      const { authUsers, profiles } = await recordAccountsFor([email]);

      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual({ accountType: MESSAGES.accountTypeInvalid });
      expect(authUsers).toHaveLength(0);
      expect(profiles).toHaveLength(0);
    },
  );

  test("[TC-AUTH-025] should_reject_a_client_supplied_role_and_create_nothing", async () => {
    const email = emailFor("role-injection");

    const res = await signup({ accountType: "ATTENDEE", role: "COORDINATOR", name: "spm123 injector", email, password: PASSWORD });
    const { authUsers } = await recordAccountsFor([email]);

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ role: MESSAGES.fieldNotAllowed });
    expect(authUsers).toHaveLength(0);
  });
});

describe("[TC-AUTH-028] concurrent sign-up", () => {
  test("should_create_exactly_one_account_when_the_same_email_signs_up_in_parallel", async () => {
    const email = emailFor("race");

    const responses = await Promise.all([1, 2, 3].map((attempt) =>
      signup({ accountType: "ATTENDEE", name: `spm123 race ${attempt}`, email, password: PASSWORD })));
    const { authUsers, profiles } = await recordAccountsFor([email]);

    expect(responses.map((res) => res.status).sort()).toEqual([201, 409, 409]);
    expect(authUsers).toHaveLength(1);
    expect(profiles).toEqual([expect.objectContaining({ auth_user_id: authUsers[0].id })]);
  });
});
