// Route-level tests for POST /api/auth/signup: real app, routes, validation and
// rate limiting, with the user model (which calls Supabase) mocked.
process.env.SIGNUP_RATE_LIMIT_MAX = "1000";

jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");

const express = require("express");
const request = require("supertest");
const app = require("../../app");
const userModel = require("../../model/userModel");
const { createSignupRateLimit } = require("../../middleware/rateLimit");
const { MESSAGES, PASSWORD_REQUIREMENTS } = require("../../validators/authValidator");

const signupError = (code) => Object.assign(new Error(code), { name: "SignupError", code });
const body = (overrides = {}) => ({
  accountType: "ATTENDEE",
  name: "Synthetic Attendee",
  email: "Attendee@ConnectSphere.test",
  password: "Passw0rdOK",
  ...overrides,
});
const signup = (payload) => request(app).post("/api/auth/signup").send(payload);

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("[SPM-123 AC1] successful sign-up", () => {
  test.each([
    ["ATTENDEE", "/my-registrations"],
    ["ORGANISER", "/dashboard"],
  ])("should_return_201_with_the_%s_profile_and_home_path_when_details_are_valid", async (role, homePath) => {
    userModel.createSignupAccount.mockResolvedValue({ user_id: 9, email: "attendee@connectsphere.test", name: "Synthetic Attendee", role });

    const res = await signup(body({ accountType: role }));

    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      message: "Account created. You can now log in.",
      user: { user_id: 9, email: "attendee@connectsphere.test", name: "Synthetic Attendee", role, roles: [role], home_path: homePath },
    });
    expect(res.body).not.toHaveProperty("session");
  });

  test("should_pass_normalised_details_to_the_model_when_signing_up", async () => {
    userModel.createSignupAccount.mockResolvedValue({ user_id: 9, email: "attendee@connectsphere.test", name: "N", role: "ATTENDEE" });

    await signup(body({ name: "  Synthetic Attendee  " }));

    expect(userModel.createSignupAccount).toHaveBeenCalledWith({
      accountType: "ATTENDEE",
      name: "Synthetic Attendee",
      email: "attendee@connectsphere.test",
      password: "Passw0rdOK",
    });
  });
});

describe("[SPM-123 AC2] duplicate email", () => {
  test("should_return_a_generic_409_that_does_not_confirm_an_account_when_email_is_unavailable", async () => {
    userModel.createSignupAccount.mockRejectedValue(signupError("EMAIL_UNAVAILABLE"));

    const res = await signup(body());

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "The email cannot be used for registration.", code: "EMAIL_UNAVAILABLE" });
    expect(JSON.stringify(res.body)).not.toMatch(/exist|registered|taken/i);
  });
});

describe("[SPM-123 AC3-AC5] validation", () => {
  test("[AC3] should_return_field_errors_without_creating_an_account_when_required_fields_are_blank", async () => {
    const res = await signup({ accountType: "", name: " ", email: "", password: "" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: {
        accountType: MESSAGES.accountTypeRequired,
        name: MESSAGES.nameRequired,
        email: MESSAGES.emailRequired,
        password: MESSAGES.passwordRequired,
      },
    });
    expect(userModel.createSignupAccount).not.toHaveBeenCalled();
  });

  test("[AC4] should_explain_password_requirements_when_password_is_weak", async () => {
    const res = await signup(body({ password: "short1" }));

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ password: PASSWORD_REQUIREMENTS });
    expect(userModel.createSignupAccount).not.toHaveBeenCalled();
  });

  test("[AC5] should_return_email_format_error_when_email_is_invalid", async () => {
    const res = await signup(body({ email: "not-an-email" }));

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ email: MESSAGES.emailInvalid });
  });

  test.each(["COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT"])(
    "[TC-AUTH-025] should_reject_%s_without_creating_an_account_when_chosen_as_account_type",
    async (accountType) => {
      const res = await signup(body({ accountType }));

      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual({ accountType: MESSAGES.accountTypeInvalid });
      expect(userModel.createSignupAccount).not.toHaveBeenCalled();
    },
  );

  test("[TC-AUTH-025] should_reject_a_client_supplied_role_even_when_account_type_is_allowed", async () => {
    const res = await signup(body({ role: "COORDINATOR", user_id: 1, auth_user_id: "x", organisation_id: 3 }));

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(["auth_user_id", "organisation_id", "role", "user_id"]);
    expect(userModel.createSignupAccount).not.toHaveBeenCalled();
  });

  test.each([[[]], ["text"]])("should_return_400_when_body_is_%j", async (payload) => {
    const res = await request(app).post("/api/auth/signup").set("Content-Type", "application/json").send(JSON.stringify(payload));

    expect(res.status).toBe(400);
    expect(res.body.code).toMatch(/VALIDATION_FAILED|INVALID_JSON/);
  });

  test("should_map_a_supabase_weak_password_rejection_to_the_requirements_message", async () => {
    userModel.createSignupAccount.mockRejectedValue(signupError("WEAK_PASSWORD"));

    const res = await signup(body());

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ password: PASSWORD_REQUIREMENTS });
  });

  test("should_map_a_supabase_email_rejection_to_the_email_format_message", async () => {
    userModel.createSignupAccount.mockRejectedValue(signupError("INVALID_SIGNUP_DETAILS"));

    const res = await signup(body());

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ email: MESSAGES.emailInvalid });
  });
});

describe("[TC-AUTH-018] safe failures", () => {
  test("should_return_a_generic_500_without_internal_detail_when_account_creation_fails", async () => {
    userModel.createSignupAccount.mockRejectedValue(new Error("[Supabase Auth Error] 500 secret-detail"));

    const res = await signup(body());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("[TC-AUTH-027] sign-up rate limit", () => {
  const limitedApp = () => {
    const mini = express();
    mini.use(express.json());
    mini.post("/signup", createSignupRateLimit({ limit: 2 }), (req, res) => res.status(201).json({}));
    return mini;
  };

  test("should_return_429_in_the_api_error_shape_when_attempts_exceed_the_limit", async () => {
    const mini = limitedApp();

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await request(mini).post("/signup").send({})).status);
    }
    const blocked = await request(mini).post("/signup").send({});

    expect(statuses).toEqual([201, 201, 429]);
    expect(blocked.body).toEqual({ error: "Too many sign-up attempts. Please wait and try again.", code: "RATE_LIMITED" });
    expect(blocked.headers).toHaveProperty("ratelimit");
  });

  test("should_default_to_5_attempts_per_15_minutes_when_no_override_is_set", () => {
    const { SIGNUP_LIMIT_DEFAULT, SIGNUP_WINDOW_MS } = require("../../middleware/rateLimit");

    expect(SIGNUP_LIMIT_DEFAULT).toBe(5);
    expect(SIGNUP_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe("[SPM-32 regression] existing auth routes", () => {
  test("should_still_require_a_token_when_get_me_is_called", async () => {
    const res = await request(app).get("/api/auth/me");

    expect(res.status).toBe(401);
  });

  test("should_still_return_204_when_logout_is_called_without_a_token", async () => {
    const res = await request(app).post("/api/auth/logout");

    expect(res.status).toBe(204);
  });

  test("should_still_return_404_when_backend_login_is_requested", async () => {
    const res = await request(app).post("/api/auth/login").send({});

    expect(res.status).toBe(404);
  });
});
