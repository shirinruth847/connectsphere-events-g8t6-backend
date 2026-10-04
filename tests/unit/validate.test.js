const { validateLogin } = require("../../middleware/validate");

const runValidateLogin = (body) => {
  const req = { body };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  validateLogin(req, res, next);
  return { req, res, next };
};

describe("validateLogin", () => {
  test("accepts both fields and trims only the email", () => {
    const { req, next } = runValidateLogin({ email: "  ec@connectsphere.test ", password: " secret " });
    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ email: "ec@connectsphere.test", password: " secret " });
  });

  // TC-LOGIN-008
  test("reports a blank email field", () => {
    const { res, next } = runValidateLogin({ email: "   ", password: "secret" });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: "VALIDATION_FAILED",
      fields: { email: "Email is required." },
    }));
  });

  // TC-LOGIN-009
  test("reports a blank password field", () => {
    const { res } = runValidateLogin({ email: "ec@connectsphere.test", password: "" });
    expect(res.json.mock.calls[0][0].fields).toEqual({ password: "Password is required." });
  });

  // TC-LOGIN-010
  test("reports both fields when both are missing", () => {
    const { res } = runValidateLogin({});
    expect(res.json.mock.calls[0][0].fields).toEqual({
      email: "Email is required.",
      password: "Password is required.",
    });
  });

  test("rejects unknown fields such as a client-supplied role", () => {
    const { res, next } = runValidateLogin({ email: "a@b.test", password: "x", role: "COORDINATOR" });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].code).toBe("UNKNOWN_FIELDS");
  });

  test("rejects non-string and oversized values", () => {
    const { res } = runValidateLogin({ email: ["a@b.test"], password: "x".repeat(129) });
    expect(res.json.mock.calls[0][0].fields).toEqual({
      email: "Email must be text.",
      password: "Password must be at most 128 characters.",
    });
  });

  test("rejects a body that is not an object", () => {
    const { res } = runValidateLogin(undefined);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
