const { validateLogin } = require("../../middleware/validate");

const runValidateLogin = (body) => {
  const req = { body };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  validateLogin(req, res, next);
  return { req, res, next };
};

describe("[TC-LOGIN-008..010] validateLogin", () => {
  test("should_accept_and_trim_only_email_when_both_fields_are_present", () => {
    const { req, next } = runValidateLogin({ email: "  ec@connectsphere.test ", password: " secret " });
    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ email: "ec@connectsphere.test", password: " secret " });
  });

  test("[TC-LOGIN-008] should_return_email_field_error_when_email_is_blank", () => {
    const { res, next } = runValidateLogin({ email: "   ", password: "secret" });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "VALIDATION_FAILED",
      fields: { email: "Email is required." },
    }));
  });

  test("[TC-LOGIN-009] should_return_password_field_error_when_password_is_blank", () => {
    const { res } = runValidateLogin({ email: "ec@connectsphere.test", password: "" });
    expect(res.json.mock.calls[0][0].fields).toEqual({ password: "Password is required." });
  });

  test("[TC-LOGIN-010] should_return_both_field_errors_when_both_fields_are_missing", () => {
    const { res } = runValidateLogin({});
    expect(res.json.mock.calls[0][0].fields).toEqual({
      email: "Email is required.",
      password: "Password is required.",
    });
  });

  test("[TC-AUTH-003] should_reject_unknown_fields_when_client_supplies_a_role", () => {
    const { res, next } = runValidateLogin({ email: "a@b.test", password: "x", role: "COORDINATOR" });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe("UNKNOWN_FIELDS");
  });

  test("should_reject_values_when_they_are_not_text_or_exceed_max_length", () => {
    const { res } = runValidateLogin({ email: ["a@b.test"], password: "x".repeat(129) });
    expect(res.json.mock.calls[0][0].fields).toEqual({
      email: "Email must be text.",
      password: "Password must be at most 128 characters.",
    });
  });

  test("should_return_400_when_body_is_not_an_object", () => {
    const { res } = runValidateLogin(undefined);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
