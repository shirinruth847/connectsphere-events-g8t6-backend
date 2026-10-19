jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");

const { requireAuth, getBearerToken } = require("../../middleware/auth");
const { requireRole } = require("../../middleware/authorize");
const errorHandler = require("../../middleware/errorHandler");
const userModel = require("../../model/userModel");

const mockResponse = () => {
  const res = { set: jest.fn(), status: jest.fn(), json: jest.fn(), headersSent: false };
  res.status.mockReturnValue(res);
  return res;
};

const requestWith = (authorization) => ({ get: (name) => (name.toLowerCase() === "authorization" ? authorization : undefined) });

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("[TC-AUTH-005] getBearerToken", () => {
  test.each([
    ["Bearer abc.def.ghi", "abc.def.ghi"],
    ["bearer abc", "abc"],
    ["Basic abc", null],
    ["Bearer", null],
    ["Bearer a b", null],
    [undefined, null],
  ])("should_extract_%p_as_%p", (header, expected) => {
    expect(getBearerToken(requestWith(header))).toBe(expected);
  });
});

describe("[TC-LOGIN-011] requireAuth", () => {
  test("should_set_no_store_and_return_401_when_token_is_missing", async () => {
    const res = mockResponse();
    const next = jest.fn();

    await requireAuth(requestWith(undefined), res, next);

    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(userModel.verifyAccessToken).not.toHaveBeenCalled();
  });

  test("should_attach_the_database_profile_when_token_and_profile_are_valid", async () => {
    const profile = { user_id: 3, role: "COORDINATOR", organisation_ids: [] };
    userModel.verifyAccessToken.mockResolvedValue("auth-3");
    userModel.findUserByAuthId.mockResolvedValue(profile);
    const req = requestWith("Bearer token");
    const next = jest.fn();

    await requireAuth(req, mockResponse(), next);

    expect(req.user).toBe(profile);
    expect(next).toHaveBeenCalledWith();
    expect(userModel.findUserByAuthId).toHaveBeenCalledWith("auth-3");
  });

  test("should_return_401_without_loading_a_profile_when_token_is_rejected", async () => {
    userModel.verifyAccessToken.mockResolvedValue(null);
    const res = mockResponse();

    await requireAuth(requestWith("Bearer revoked"), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(userModel.findUserByAuthId).not.toHaveBeenCalled();
  });

  test("should_pass_the_error_on_when_supabase_is_unavailable", async () => {
    const outage = new Error("[Supabase Auth Error] 503");
    userModel.verifyAccessToken.mockRejectedValue(outage);
    const next = jest.fn();

    await requireAuth(requestWith("Bearer token"), mockResponse(), next);

    expect(next).toHaveBeenCalledWith(outage);
  });
});

describe("[TC-LOGIN-004/005] requireRole", () => {
  test("should_call_next_when_role_is_allowed", () => {
    const next = jest.fn();

    requireRole("ORGANISER", "COORDINATOR")({ user: { role: "COORDINATOR" } }, mockResponse(), next);

    expect(next).toHaveBeenCalled();
  });

  test("should_return_403_when_role_is_not_allowed", () => {
    const res = mockResponse();

    requireRole("ORGANISER")({ user: { role: "ATTENDEE" } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  test("should_return_401_when_used_without_an_authenticated_user", () => {
    const res = mockResponse();

    requireRole("ORGANISER")({}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe("[TC-AUTH-018] errorHandler", () => {
  test("should_return_413_when_body_is_too_large", () => {
    const res = mockResponse();

    errorHandler({ type: "entity.too.large" }, {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
  });

  test("should_return_a_generic_500_without_internal_detail_when_error_is_unexpected", () => {
    const res = mockResponse();

    errorHandler(new Error("SELECT secret FROM internal"), {}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });

  test("should_delegate_when_headers_were_already_sent", () => {
    const res = { ...mockResponse(), headersSent: true };
    const next = jest.fn();
    const error = new Error("late");

    errorHandler(error, {}, res, next);

    expect(next).toHaveBeenCalledWith(error);
  });
});
