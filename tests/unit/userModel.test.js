// Unit tests for the identity model. Only the Supabase client (an external
// dependency) is mocked; the model's own error classification is under test.
const mockClient = { from: jest.fn(), auth: { getUser: jest.fn(), admin: { signOut: jest.fn() } } };
const mockSessionClient = { auth: { signInWithPassword: jest.fn() } };

jest.mock("../../config/supabase", () => {
  mockClient.createSessionClient = jest.fn(() => mockSessionClient);
  return mockClient;
});

const {
  authenticateWithPassword,
  verifyAccessToken,
  revokeSession,
  findUserByAuthId,
} = require("../../model/userModel");

const authError = (status, code) => Object.assign(new Error(code), { status, code });

const mockProfileQuery = (result) => {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  };
  mockClient.from.mockReturnValue(query);
  return query;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("[TC-LOGIN-006/007] authenticateWithPassword", () => {
  test("should_return_the_session_when_supabase_accepts_the_credentials", async () => {
    const session = { access_token: "a", user: { id: "u" } };
    mockSessionClient.auth.signInWithPassword.mockResolvedValue({ data: { session }, error: null });

    await expect(authenticateWithPassword("a@b.test", "pw")).resolves.toBe(session);
    expect(mockSessionClient.auth.signInWithPassword).toHaveBeenCalledWith({ email: "a@b.test", password: "pw" });
  });

  test.each([
    [400, "invalid_credentials"],
    [400, "email_not_confirmed"],
    [422, "validation_failed"],
  ])("should_return_null_when_supabase_rejects_with_%s_%s", async (status, code) => {
    mockSessionClient.auth.signInWithPassword.mockResolvedValue({ data: {}, error: authError(status, code) });

    await expect(authenticateWithPassword("a@b.test", "pw")).resolves.toBeNull();
  });

  test("should_throw_a_rate_limit_error_when_supabase_returns_429", async () => {
    mockSessionClient.auth.signInWithPassword.mockResolvedValue({ data: {}, error: authError(429, "over_request_rate_limit") });

    await expect(authenticateWithPassword("a@b.test", "pw")).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
  });

  test("should_throw_when_supabase_auth_is_unavailable", async () => {
    mockSessionClient.auth.signInWithPassword.mockResolvedValue({ data: {}, error: authError(503, "unavailable") });

    await expect(authenticateWithPassword("a@b.test", "pw")).rejects.toThrow("[Supabase Auth Error] 503");
  });

  test("should_use_a_fresh_session_client_when_each_login_runs", async () => {
    mockSessionClient.auth.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });

    await authenticateWithPassword("a@b.test", "pw");
    await authenticateWithPassword("c@d.test", "pw");

    expect(mockClient.createSessionClient).toHaveBeenCalledTimes(2);
  });
});

describe("[TC-LOGIN-011/013] verifyAccessToken", () => {
  test("should_return_the_auth_user_id_when_supabase_accepts_the_token", async () => {
    mockClient.auth.getUser.mockResolvedValue({ data: { user: { id: "auth-1" } }, error: null });

    await expect(verifyAccessToken("token")).resolves.toBe("auth-1");
    expect(mockClient.auth.getUser).toHaveBeenCalledWith("token");
  });

  test.each([
    [401, "no_authorization"],
    [403, "bad_jwt"],
    [403, "session_not_found"],
  ])("should_return_null_when_supabase_rejects_the_token_with_%s_%s", async (status, code) => {
    mockClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: authError(status, code) });

    await expect(verifyAccessToken("token")).resolves.toBeNull();
  });

  test("should_throw_when_supabase_auth_cannot_be_reached", async () => {
    mockClient.auth.getUser.mockResolvedValue({ data: { user: null }, error: authError(0, "fetch_failed") });

    await expect(verifyAccessToken("token")).rejects.toThrow("[Supabase Auth Error]");
  });
});

describe("[TC-LOGIN-013] revokeSession", () => {
  test("should_revoke_only_the_current_session_when_logging_out", async () => {
    mockClient.auth.admin.signOut.mockResolvedValue({ data: null, error: null });

    await revokeSession("token");

    expect(mockClient.auth.admin.signOut).toHaveBeenCalledWith("token", "local");
  });

  test("should_succeed_when_the_session_is_already_revoked", async () => {
    mockClient.auth.admin.signOut.mockResolvedValue({ data: null, error: authError(403, "session_not_found") });

    await expect(revokeSession("token")).resolves.toBeUndefined();
  });

  test("should_throw_when_supabase_fails_to_revoke", async () => {
    mockClient.auth.admin.signOut.mockResolvedValue({ data: null, error: authError(500, "unexpected_failure") });

    await expect(revokeSession("token")).rejects.toThrow("[Supabase Auth Error] 500");
  });
});

describe("[TC-AUTH-009] findUserByAuthId", () => {
  test("should_return_profile_with_organisation_ids_when_profile_is_active", async () => {
    const query = mockProfileQuery({
      data: {
        user_id: 4, email: "e@x.test", name: "E", role: "ORGANISER", is_active: true,
        organisation_membership: [{ organisation_id: 2 }, { organisation_id: 5 }],
      },
      error: null,
    });

    await expect(findUserByAuthId("auth-1")).resolves.toEqual({
      user_id: 4, email: "e@x.test", name: "E", role: "ORGANISER", organisation_ids: [2, 5],
    });
    expect(query.eq).toHaveBeenCalledWith("auth_user_id", "auth-1");
  });

  test("should_return_null_when_no_profile_is_linked", async () => {
    mockProfileQuery({ data: null, error: null });

    await expect(findUserByAuthId("auth-1")).resolves.toBeNull();
  });

  test("should_return_null_when_profile_is_inactive", async () => {
    mockProfileQuery({
      data: { user_id: 4, role: "ATTENDEE", is_active: false, organisation_membership: [] },
      error: null,
    });

    await expect(findUserByAuthId("auth-1")).resolves.toBeNull();
  });

  test("should_throw_when_the_profile_query_fails", async () => {
    mockProfileQuery({ data: null, error: { message: "permission denied for table user" } });

    await expect(findUserByAuthId("auth-1")).rejects.toThrow("permission denied");
  });
});
