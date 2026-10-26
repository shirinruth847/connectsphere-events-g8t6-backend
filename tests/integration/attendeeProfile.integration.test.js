// SPM-270 live integration tests: real Express routes, middleware, Supabase
// Auth and the shared development database from .env. Nothing is mocked.
// Users sign in with Supabase Auth as the browser does. Fixtures are synthetic,
// namespaced by run ID and recorded in a manifest; profiles go with their
// fixture users (attendee_profile.user_id ON DELETE CASCADE), and afterAll
// checks that nothing this run created is left.
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, countFixtureActivity, MANIFEST_DIR } = require("../fixtures/authFixtures");
const { findAttendeeProfile } = require("../../model/attendeeProfileModel");

jest.setTimeout(240000);

const runId = newRunId();
const RACE_ROUNDS = ["raceOne", "raceTwo", "raceThree"];
const NON_ATTENDEES = ["organiserA", "coordinator", "coordinatorLead", "venueStaff", "techSupport", "safetyOfficer"];
// Every attendee whose profile a test creates, so cleanup can be checked.
const PROFILE_OWNERS = ["attendee", "deactivatable", "fieldGuard", "lostUpdate", "registrationReader", ...RACE_ROUNDS];
const ATTENDEE_PHONE = "+65 8000 2700";
const PROFILE_KEYS = [
  "accessibilityRequirements",
  "attendeeId",
  "createdAt",
  "dietaryRestrictions",
  "email",
  "name",
  "phone",
  "updatedAt",
  "userId",
  "version",
];

let fixtures;
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      return session;
    }));
  }
  return sessions.get(key);
};

const bearer = async (key) => `Bearer ${(await signIn(key)).access_token}`;
const getMine = async (key) => request(app).get("/api/attendee-profile/mine").set("Authorization", await bearer(key));
const putMine = async (key, body) => request(app).put("/api/attendee-profile/mine").set("Authorization", await bearer(key)).send(body);
const body = (dietaryRestrictions, accessibilityRequirements, version) => ({ dietaryRestrictions, accessibilityRequirements, version });

const userRow = async (key) => {
  const { data, error } = await supabase.from("user").select("name, email, phone, role").eq("user_id", fixtures.accounts[key].userId).single();
  if (error) throw error;
  return data;
};

const notificationCount = async (key) => {
  const { count, error } = await supabase
    .from("notification_recipient")
    .select("notification_id", { count: "exact", head: true })
    .eq("recipient_id", fixtures.accounts[key].userId);
  if (error) throw error;
  return count;
};

// Same header and signature, but a payload claiming another identity.
const tamperedToken = (accessToken) => {
  const [header, payload, signature] = accessToken.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const forged = { ...claims, sub: "00000000-0000-0000-0000-000000000000", role: "service_role", user_role: "ATTENDEE" };
  return [header, Buffer.from(JSON.stringify(forged)).toString("base64url"), signature].join(".");
};

beforeAll(async () => {
  fixtures = await createAuthFixtures(runId, {
    extraAccounts: [
      { key: "safetyOfficer", role: "SAFETY_OFFICER" },
      { key: "fieldGuard", role: "ATTENDEE" },
      { key: "lostUpdate", role: "ATTENDEE" },
      { key: "registrationReader", role: "ATTENDEE" },
      ...RACE_ROUNDS.map((key) => ({ key, role: "ATTENDEE" })),
    ],
  });
  // Trusted setup on this run's own fixture rows, so phone is checked with a value.
  const { error } = await supabase
    .from("user")
    .update({ phone: ATTENDEE_PHONE })
    .in("user_id", [fixtures.accounts.attendee.userId, fixtures.accounts.registrationReader.userId])
    .like("email", `spm32-${runId}-%`);
  if (error) throw error;
});

afterAll(async () => {
  if (!fixtures) return;
  await cleanupAuthFixtures(runId);
  // cleanupAuthFixtures verifies its own lists; it does not know attendee_profile.
  // A profile can outlive cleanup only if its owner was kept, so every profile
  // owner must be gone and the manifest removed.
  const ownerIds = PROFILE_OWNERS.map((key) => fixtures.accounts[key].userId);
  const { count, error } = await supabase.from("user").select("user_id", { count: "exact", head: true }).in("user_id", ownerIds);
  if (error) throw error;
  expect(count).toBe(0);
  for (const userId of ownerIds) {
    const { data, error: rpcError } = await supabase.rpc("get_attendee_profile", { p_user_id: userId });
    if (rpcError) throw rpcError;
    expect(data).toBeNull();
  }
  expect(fs.existsSync(path.join(MANIFEST_DIR, `spm32-${runId}.json`))).toBe(false);
});

describe("[SPM-270] authentication and role (AC1)", () => {
  test.each([["get"], ["put"]])("[TC-PROFILE-002] should_return_401_when_%s_has_no_token", async (method) => {
    const res = await request(app)[method]("/api/attendee-profile/mine").send(body("Vegan", null, null));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  test("[TC-PROFILE-002] should_return_401_when_the_token_is_malformed_or_tampered", async () => {
    const session = await signIn("attendee");
    const malformed = await request(app).get("/api/attendee-profile/mine").set("Authorization", "Bearer not-a-jwt");
    const tampered = await request(app)
      .put("/api/attendee-profile/mine")
      .set("Authorization", `Bearer ${tamperedToken(session.access_token)}`)
      .send(body("Forged", null, null));
    expect([malformed.status, tampered.status]).toEqual([401, 401]);
    expect((await getMine("attendee")).body.profile.dietaryRestrictions).not.toBe("Forged");
  });

  test.each([["inactive"], ["unlinked"]])(
    "[TC-PROFILE-002] should_return_401_when_the_%s_account_signs_in_without_an_active_profile",
    async (key) => {
      const read = await getMine(key);
      const write = await putMine(key, body("Vegan", null, null));
      expect([read.status, write.status]).toEqual([401, 401]);
    }
  );

  test.each(NON_ATTENDEES)("[TC-PROFILE-003] should_return_403_and_create_nothing_when_%s_uses_the_profile", async (key) => {
    const read = await getMine(key);
    const write = await putMine(key, body("Vegan", null, null));
    expect([read.status, write.status]).toEqual([403, 403]);
    expect(write.body.code).toBe("FORBIDDEN");
    await expect(findAttendeeProfile(fixtures.accounts[key].userId)).rejects.toMatchObject({ code: "NOT_ATTENDEE" });
  });

  test("[TC-PROFILE-009] should_return_404_when_a_request_names_a_profile_id", async () => {
    const res = await request(app).get(`/api/attendee-profile/${fixtures.accounts.deactivatable.userId}`).set("Authorization", await bearer("attendee"));
    expect(res.status).toBe(404);
  });
});

describe("[SPM-270] own profile journey (AC2, AC3, AC5, AC6, AC7)", () => {
  test("[TC-PROFILE-001] should_show_user_details_and_blank_profile_fields_when_no_profile_is_saved", async () => {
    const res = await getMine("attendee");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.profile).toEqual({
      attendeeId: null,
      userId: fixtures.accounts.attendee.userId,
      name: "spm32 attendee",
      email: fixtures.accounts.attendee.email,
      phone: ATTENDEE_PHONE,
      dietaryRestrictions: null,
      accessibilityRequirements: null,
      version: null,
      createdAt: null,
      updatedAt: null,
    });
  });

  test("[TC-PROFILE-004] [TC-PROFILE-006] [TC-PROFILE-007] [TC-PROFILE-008] [TC-PROFILE-011] should_create_update_clear_and_read_back_when_an_attendee_saves_in_turn", async () => {
    const activityBefore = await countFixtureActivity(fixtures);
    const notificationsBefore = await notificationCount("attendee");

    const created = await putMine("attendee", body("Vegetarian", null, null));
    expect(created.status).toBe(201);
    expect(Object.keys(created.body.profile).sort()).toEqual(PROFILE_KEYS);
    expect(created.body.profile).toMatchObject({
      userId: fixtures.accounts.attendee.userId,
      name: "spm32 attendee",
      phone: ATTENDEE_PHONE,
      dietaryRestrictions: "Vegetarian",
      accessibilityRequirements: null,
      version: 1,
    });
    expect(Number.isInteger(created.body.profile.attendeeId)).toBe(true);

    const accessibility = await putMine("attendee", body("Vegetarian", "Wheelchair access", 1));
    expect(accessibility.status).toBe(200);
    expect(accessibility.body.profile).toMatchObject({ attendeeId: created.body.profile.attendeeId, accessibilityRequirements: "Wheelchair access", version: 2 });

    const dietary = await putMine("attendee", body("  Gluten-free  ", "Wheelchair access", 2));
    expect(dietary.body.profile).toMatchObject({ dietaryRestrictions: "Gluten-free", version: 3 });

    const cleared = await putMine("attendee", body("", "   ", 3));
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile).toMatchObject({ dietaryRestrictions: null, accessibilityRequirements: null, version: 4 });

    const restored = await putMine("attendee", body(null, "Wheelchair access", 4));
    expect((await getMine("attendee")).body.profile).toEqual(restored.body.profile);

    // Master 7.1 and 8 define no activity entry or notification for a profile save.
    expect(await countFixtureActivity(fixtures)).toBe(activityBefore);
    expect(await notificationCount("attendee")).toBe(notificationsBefore);
  });

  test("[TC-PROFILE-011] should_store_text_unchanged_when_it_has_non_ascii_characters", async () => {
    const text = "Gluten-free 🌾, 素食, café — no peanuts";
    const saved = await putMine("fieldGuard", body(text, "Ramp ♿", null));
    expect(saved.status).toBe(201);
    expect((await getMine("fieldGuard")).body.profile).toMatchObject({ dietaryRestrictions: text, accessibilityRequirements: "Ramp ♿" });
  });
});

describe("[SPM-270] field guard (AC8, TC-PROFILE-010)", () => {
  test.each([
    ["name", "Renamed"],
    ["email", "renamed@connectsphere.test"],
    ["phone", "+65 9999 9999"],
    ["role", "ORGANISER"],
    ["userId", 1],
    ["attendeeId", 1],
    ["createdAt", "2020-01-01T00:00:00Z"],
    ["notes", "anything"],
  ])("[TC-PROFILE-009] should_return_400_and_change_nothing_when_the_body_sets_%s", async (key, value) => {
    const userBefore = await userRow("fieldGuard");
    const profileBefore = (await getMine("fieldGuard")).body.profile;
    const res = await putMine("fieldGuard", { ...body("Changed", null, profileBefore.version), [key]: value });
    expect(res.status).toBe(400);
    expect(res.body.fields[key]).toBe("This field cannot be set.");
    expect(await userRow("fieldGuard")).toEqual(userBefore);
    expect((await getMine("fieldGuard")).body.profile).toEqual(profileBefore);
  });

  test.each([
    ["over-long text", () => body("x".repeat(1001), null, 1)],
    ["non-text value", () => body(42, null, 1)],
    ["missing field", () => ({ dietaryRestrictions: "Vegan", version: 1 })],
    ["invalid version", () => body("Vegan", null, "1")],
  ])("[TC-PROFILE-010] should_return_400_and_keep_the_stored_profile_when_the_save_has_%s", async (label, makeBody) => {
    const before = (await getMine("fieldGuard")).body.profile;
    const res = await putMine("fieldGuard", makeBody());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.profile).toBeUndefined();
    expect((await getMine("fieldGuard")).body.profile).toEqual(before);
  });

  test("[TC-PROFILE-010] should_return_400_and_keep_the_stored_profile_when_text_contains_a_nul_character", async () => {
    const before = (await getMine("fieldGuard")).body.profile;
    const res = await putMine("fieldGuard", body("Vegan\u0000", null, before.version));
    expect(res.status).toBe(400);
    expect((await getMine("fieldGuard")).body.profile).toEqual(before);
  });
});

describe("[SPM-270] one profile per attendee and stale saves (AC4, TC-PROFILE-005)", () => {
  test("[TC-PROFILE-005] should_return_409_and_change_nothing_when_a_create_repeats_or_a_version_is_stale", async () => {
    await putMine("lostUpdate", body("Halal", null, null));
    await putMine("lostUpdate", body("Halal", "Ramp", 1));
    const before = (await getMine("lostUpdate")).body.profile;
    const duplicate = await putMine("lostUpdate", body("Kosher", null, null));
    const stale = await putMine("lostUpdate", body("Kosher", null, 1));
    const future = await putMine("lostUpdate", body("Kosher", null, 99));
    expect([duplicate.status, stale.status, future.status]).toEqual([409, 409, 409]);
    expect(stale.body.code).toBe("STALE_PROFILE");
    expect((await getMine("lostUpdate")).body.profile).toEqual(before);
  });

  test.each(RACE_ROUNDS)("[TC-PROFILE-005] should_create_exactly_one_profile_when_parallel_first_saves_race_%s", async (key) => {
    await signIn(key);
    const results = await Promise.all(["A", "B", "C"].map((text) => putMine(key, body(`First save ${text}`, null, null))));
    const statuses = results.map((res) => res.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    const winner = results.find((res) => res.status === 201).body.profile;
    expect(winner.version).toBe(1);
    expect((await getMine(key)).body.profile).toEqual(winner);
  });

  test("[TC-PROFILE-005] should_accept_one_of_two_parallel_updates_when_both_send_the_same_version", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { version } = (await getMine("lostUpdate")).body.profile;
      const results = await Promise.all([
        putMine("lostUpdate", body(`Round ${round} left`, null, version)),
        putMine("lostUpdate", body(`Round ${round} right`, null, version)),
      ]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
      const winner = results.find((res) => res.status === 200).body.profile;
      const after = (await getMine("lostUpdate")).body.profile;
      expect(after.version).toBe(version + 1);
      expect(after.dietaryRestrictions).toBe(winner.dietaryRestrictions);
    }
  });
});

describe("[SPM-270] another attendee's profile (AC8)", () => {
  test("[TC-PROFILE-009] should_leave_the_other_profile_unchanged_when_an_attendee_tries_to_target_it", async () => {
    await putMine("deactivatable", body("Private dietary note", "Private access note", null));
    const other = (await getMine("deactivatable")).body.profile;
    const forged = await putMine("attendee", { ...body("Overwritten", null, other.version), userId: other.userId, attendeeId: other.attendeeId });
    expect(forged.status).toBe(400);
    const mine = (await getMine("attendee")).body.profile;
    expect(mine.userId).toBe(fixtures.accounts.attendee.userId);
    expect(JSON.stringify(mine)).not.toContain("Private");
    expect((await getMine("deactivatable")).body.profile).toEqual(other);
  });
});

describe("[SPM-270] Event Registration reuse (AC10)", () => {
  test("[TC-PROFILE-012] should_return_name_email_phone_and_preferences_when_registration_reads_the_profile", async () => {
    const saved = await putMine("registrationReader", body("Vegan", "Hearing loop", null));
    expect(saved.status).toBe(201);
    const profile = await findAttendeeProfile(fixtures.accounts.registrationReader.userId);
    expect(profile).toEqual(saved.body.profile);
    expect(profile).toMatchObject({
      name: "spm32 registrationReader",
      email: fixtures.accounts.registrationReader.email,
      phone: ATTENDEE_PHONE,
      dietaryRestrictions: "Vegan",
      accessibilityRequirements: "Hearing loop",
    });
  });
});
