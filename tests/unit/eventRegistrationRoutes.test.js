// Route-level unit tests for SPM-134: real Express app, routes, middleware and
// controller. Only registerForEvent and the Supabase-backed user lookup are mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/registrationModel", () => ({
  ...jest.requireActual("../../model/registrationModel"),
  registerForEvent: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const registrationModel = require("../../model/registrationModel");

const USER_ID = 21;
const CONFIRMATION = {
  registrationId: 42,
  confirmationNumber: "REG-000042",
  status: "REGISTERED",
  registeredAt: "2026-10-29T01:00:00+00:00",
  dietaryRestrictions: "Vegetarian, no peanuts",
  accessibilityRequirements: null,
  event: { eventId: 7, title: "Synthetic Forum", startDatetime: "2026-11-05T01:00:00+00:00", endDatetime: "2026-11-05T03:00:00+00:00", organisationName: null },
};
const BODY = { dietaryRestrictions: "Vegetarian, no peanuts", accessibilityRequirements: null };
const NON_ATTENDEE_ROLES = ["ORGANISER", "COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "TECH_SUPPORT", "SAFETY_OFFICER"];

const signedInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: USER_ID, role, organisation_ids: [] });
};
const registrationError = (code) => Object.assign(new Error(code), { name: "RegistrationError", code });
const post = (path, body = BODY) => request(app).post(path).set("Authorization", "Bearer token").send(body);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  signedInAs("ATTENDEE");
  registrationModel.registerForEvent.mockResolvedValue({ registration: CONFIRMATION, replayed: false });
});

describe("authentication and role (SPM-134)", () => {
  test("[SPM-134] should_return_401_and_register_nothing_when_there_is_no_token", async () => {
    const res = await request(app).post("/api/registrations/mine/7").send(BODY);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
    expect(registrationModel.registerForEvent).not.toHaveBeenCalled();
  });

  test.each(NON_ATTENDEE_ROLES)("[SPM-134] should_return_403_and_register_nothing_when_%s_registers", async (role) => {
    signedInAs(role);
    const res = await post("/api/registrations/mine/7");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(registrationModel.registerForEvent).not.toHaveBeenCalled();
  });
});

describe("POST /api/registrations/mine/:eventId (SPM-134)", () => {
  test("[SPM-134] should_return_201_with_the_confirmation_when_the_attendee_registers", async () => {
    const res = await post("/api/registrations/mine/7");
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ registration: CONFIRMATION });
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(registrationModel.registerForEvent).toHaveBeenCalledWith(USER_ID, 7, BODY, null);
  });

  test("[SPM-134] should_pass_the_key_and_mark_the_replay_when_an_idempotency_key_repeats", async () => {
    registrationModel.registerForEvent.mockResolvedValue({ registration: CONFIRMATION, replayed: true });
    const res = await post("/api/registrations/mine/7").set("Idempotency-Key", "spm134-key-0001");
    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(registrationModel.registerForEvent).toHaveBeenCalledWith(USER_ID, 7, BODY, "spm134-key-0001");
  });

  test("[SPM-134] should_return_400_when_the_idempotency_key_is_malformed", async () => {
    const res = await post("/api/registrations/mine/7").set("Idempotency-Key", "short");
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields)).toEqual(["idempotencyKey"]);
    expect(registrationModel.registerForEvent).not.toHaveBeenCalled();
  });

  test.each([["0"], ["abc"], ["-1"], ["99999999999"]])("[SPM-134] should_return_404_when_the_event_id_is_%s", async (id) => {
    const res = await post(`/api/registrations/mine/${id}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
    expect(registrationModel.registerForEvent).not.toHaveBeenCalled();
  });

  test("[SPM-134] should_return_400_and_register_nothing_when_the_body_sets_identity_status_or_capacity", async () => {
    const res = await post("/api/registrations/mine/7", { ...BODY, userId: 99, status: "REGISTERED", registrationCapacity: 500 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(res.body.fields).sort()).toEqual(["registrationCapacity", "status", "userId"]);
    expect(registrationModel.registerForEvent).not.toHaveBeenCalled();
  });

  test("[TC-REG-009] [TC-REG-010] should_return_the_message_for_each_missing_or_invalid_answer_and_register_nothing", async () => {
    const res = await post("/api/registrations/mine/7", { dietaryRestrictions: "x".repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: {
        dietaryRestrictions: "Enter text of 1000 characters or fewer, without control characters such as NUL.",
        accessibilityRequirements: "Send this field, as text or null to leave it blank.",
      },
    });
    expect(registrationModel.registerForEvent).not.toHaveBeenCalled();
  });

  test("[SPM-134] should_return_400_when_an_answer_contains_a_nul_character", async () => {
    const res = await post("/api/registrations/mine/7", { ...BODY, dietaryRestrictions: "Vegan\u0000" });
    expect(res.status).toBe(400);
    expect(registrationModel.registerForEvent).not.toHaveBeenCalled();
  });

  test("[SPM-134] should_return_404_when_the_database_says_the_event_is_not_visible", async () => {
    registrationModel.registerForEvent.mockRejectedValue(registrationError("EVENT_NOT_FOUND"));
    const res = await post("/api/registrations/mine/7");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
  });

  test("[SPM-134] should_return_403_when_the_database_says_the_user_is_not_an_active_attendee", async () => {
    registrationModel.registerForEvent.mockRejectedValue(registrationError("NOT_ATTENDEE"));
    expect((await post("/api/registrations/mine/7")).status).toBe(403);
  });

  test.each([
    "ALREADY_REGISTERED", "ALREADY_WAITLISTED", "REGISTRATION_NOT_ENABLED", "REGISTRATION_CLOSED", "REGISTRATION_FULL",
    "IDEMPOTENCY_KEY_REUSED", "IDEMPOTENCY_IN_PROGRESS",
  ])("[SPM-134] should_return_409_with_the_stable_code_when_registration_is_refused_as_%s", async (code) => {
    registrationModel.registerForEvent.mockRejectedValue(registrationError(code));
    const res = await post("/api/registrations/mine/7");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.registration).toBeUndefined();
  });

  test("[SPM-134] should_return_500_without_database_detail_and_never_report_success_when_the_registration_fails", async () => {
    registrationModel.registerForEvent.mockRejectedValue(new Error("[Supabase Error] connection reset"));
    const res = await post("/api/registrations/mine/7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});
