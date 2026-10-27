// Route-level unit tests for SPM-270: real Express app, routes, middleware and
// controller. Only the model functions that reach Supabase are mocked; the live
// suite (tests/integration/attendeeProfile.integration.test.js) covers the database.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/attendeeProfileModel");

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const attendeeProfileModel = require("../../model/attendeeProfileModel");

const USER_ID = 21;
const PROFILE = {
  attendeeId: 5,
  userId: USER_ID,
  name: "Attendee A",
  email: "a@example.test",
  phone: null,
  dietaryRestrictions: "Vegan",
  accessibilityRequirements: null,
  version: 1,
  createdAt: "2026-10-24T01:00:00+00:00",
  updatedAt: "2026-10-24T01:00:00+00:00",
};
const BODY = { dietaryRestrictions: "Vegan", accessibilityRequirements: null, version: null };
const NON_ATTENDEE_ROLES = ["ORGANISER", "COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "TECH_SUPPORT", "SAFETY_OFFICER"];

const signedInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: USER_ID, role, organisation_ids: [] });
};
const profileError = (code) => Object.assign(new Error(code), { name: "AttendeeProfileError", code });
const getMine = () => request(app).get("/api/attendee-profile/mine").set("Authorization", "Bearer token");
const putMine = (body) => request(app).put("/api/attendee-profile/mine").set("Authorization", "Bearer token").send(body);

const expectNoProfileAccess = () => {
  expect(attendeeProfileModel.findAttendeeProfile).not.toHaveBeenCalled();
  expect(attendeeProfileModel.saveAttendeeProfile).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs("ATTENDEE");
  attendeeProfileModel.findAttendeeProfile.mockResolvedValue(PROFILE);
  attendeeProfileModel.saveAttendeeProfile.mockResolvedValue({ profile: PROFILE, created: true });
});

describe("authentication (SPM-270 AC1)", () => {
  test.each([["get"], ["put"]])("[TC-PROFILE-002] should_return_401_when_%s_has_no_token", async (method) => {
    const res = await request(app)[method]("/api/attendee-profile/mine").send(BODY);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
    expect(res.headers["cache-control"]).toBe("no-store");
    expectNoProfileAccess();
  });

  test.each([["Token abc"], ["Bearer"], ["Bearer a b"], ["basic dXNlcjpwYXNz"]])(
    "[TC-PROFILE-002] should_return_401_when_the_authorization_header_is_%p",
    async (header) => {
      const res = await request(app).get("/api/attendee-profile/mine").set("Authorization", header);
      expect(res.status).toBe(401);
      expect(userModel.verifyAccessToken).not.toHaveBeenCalled();
      expectNoProfileAccess();
    }
  );

  test("[TC-PROFILE-002] should_return_401_when_the_token_cannot_be_verified", async () => {
    userModel.verifyAccessToken.mockResolvedValue(null);
    expect((await getMine()).status).toBe(401);
    expectNoProfileAccess();
  });

  test("[TC-PROFILE-002] should_return_401_when_the_token_has_no_active_profile", async () => {
    userModel.findUserByAuthId.mockResolvedValue(null);
    expect((await putMine(BODY)).status).toBe(401);
    expectNoProfileAccess();
  });
});

describe("role restriction (SPM-270 AC1)", () => {
  test.each(NON_ATTENDEE_ROLES.flatMap((role) => [[role, "get"], [role, "put"]]))(
    "[TC-PROFILE-003] should_return_403_and_touch_no_profile_when_%s_calls_%s",
    async (role, method) => {
      signedInAs(role);
      const res = method === "get" ? await getMine() : await putMine(BODY);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expectNoProfileAccess();
    }
  );

  test("[TC-PROFILE-003] should_return_403_when_the_database_refuses_a_non_attendee", async () => {
    attendeeProfileModel.saveAttendeeProfile.mockRejectedValue(profileError("NOT_ATTENDEE"));
    expect((await putMine(BODY)).status).toBe(403);
    attendeeProfileModel.findAttendeeProfile.mockRejectedValue(profileError("NOT_ATTENDEE"));
    expect((await getMine()).status).toBe(403);
  });

  test.each([["get", "/api/attendee-profile/5"], ["put", "/api/attendee-profile/5"], ["get", "/api/attendee-profile"]])(
    "[TC-PROFILE-009] should_return_404_when_%s_names_a_profile_path_%s",
    async (method, path) => {
      const res = await request(app)[method](path).set("Authorization", "Bearer token").send(BODY);
      expect(res.status).toBe(404);
      expectNoProfileAccess();
    }
  );
});

describe("GET /api/attendee-profile/mine (TC-PROFILE-001, TC-PROFILE-011)", () => {
  test("[TC-PROFILE-001] should_return_the_own_profile_when_an_attendee_reads_it", async () => {
    const res = await getMine();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ profile: PROFILE });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(attendeeProfileModel.findAttendeeProfile).toHaveBeenCalledWith(USER_ID);
  });

  test("[TC-PROFILE-001] should_return_500_without_database_detail_when_the_read_fails", async () => {
    attendeeProfileModel.findAttendeeProfile.mockRejectedValue(new Error("[Supabase Error] relation does not exist"));
    const res = await getMine();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("PUT /api/attendee-profile/mine (TC-PROFILE-004 to TC-PROFILE-010)", () => {
  test("[TC-PROFILE-004] should_return_201_and_save_for_the_trusted_user_when_it_is_the_first_save", async () => {
    const res = await putMine(BODY);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ profile: PROFILE });
    expect(attendeeProfileModel.saveAttendeeProfile).toHaveBeenCalledWith(USER_ID, BODY);
  });

  test("[TC-PROFILE-006] should_return_200_and_pass_the_loaded_version_when_a_profile_is_updated", async () => {
    attendeeProfileModel.saveAttendeeProfile.mockResolvedValue({ profile: { ...PROFILE, version: 2 }, created: false });
    const res = await putMine({ dietaryRestrictions: "Halal", accessibilityRequirements: "Hearing loop", version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.profile.version).toBe(2);
    expect(attendeeProfileModel.saveAttendeeProfile).toHaveBeenCalledWith(USER_ID, {
      dietaryRestrictions: "Halal",
      accessibilityRequirements: "Hearing loop",
      version: 1,
    });
  });

  test("[TC-PROFILE-008] should_save_null_when_fields_are_blank", async () => {
    await putMine({ dietaryRestrictions: "", accessibilityRequirements: "  ", version: 1 });
    expect(attendeeProfileModel.saveAttendeeProfile).toHaveBeenCalledWith(USER_ID, {
      dietaryRestrictions: null,
      accessibilityRequirements: null,
      version: 1,
    });
  });

  test("[TC-PROFILE-009] should_refuse_the_save_when_the_body_names_another_user_or_profile", async () => {
    const res = await putMine({ ...BODY, userId: 99, attendeeId: 7 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(res.body.fields).sort()).toEqual(["attendeeId", "userId"]);
    expectNoProfileAccess();
  });

  test("[TC-PROFILE-010] should_return_400_with_field_messages_and_save_nothing_when_values_are_invalid", async () => {
    const res = await putMine({ dietaryRestrictions: "x".repeat(1001), accessibilityRequirements: 3, version: 0 });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(["accessibilityRequirements", "dietaryRestrictions", "version"]);
    expectNoProfileAccess();
  });

  test("[TC-PROFILE-010] should_return_400_when_the_body_is_malformed_json", async () => {
    const res = await request(app)
      .put("/api/attendee-profile/mine")
      .set("Authorization", "Bearer token")
      .set("Content-Type", "application/json")
      .send("{");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_JSON");
    expectNoProfileAccess();
  });

  test("[TC-PROFILE-010] should_return_400_when_the_body_is_not_json", async () => {
    const res = await request(app)
      .put("/api/attendee-profile/mine")
      .set("Authorization", "Bearer token")
      .set("Content-Type", "text/plain")
      .send("dietaryRestrictions=Vegan");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expectNoProfileAccess();
  });

  test("[TC-PROFILE-010] should_return_413_when_the_body_exceeds_the_request_limit", async () => {
    const res = await putMine({ ...BODY, dietaryRestrictions: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
    expectNoProfileAccess();
  });

  test("[TC-PROFILE-005] should_return_409_stale_profile_when_a_profile_exists_or_the_version_is_old", async () => {
    attendeeProfileModel.saveAttendeeProfile.mockRejectedValue(profileError("STALE_PROFILE"));
    const res = await putMine(BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("STALE_PROFILE");
    expect(res.body.profile).toBeUndefined();
  });

  test("[TC-PROFILE-010] should_return_500_and_never_report_success_when_the_save_fails", async () => {
    attendeeProfileModel.saveAttendeeProfile.mockRejectedValue(new Error("[Supabase Error] connection reset"));
    const res = await putMine(BODY);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});
