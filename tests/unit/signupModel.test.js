// Unit tests for createSignupAccount. Only the Supabase client is mocked; the
// model's ordering, compensation and error mapping are under test.
const mockClient = {
  from: jest.fn(),
  auth: { admin: { createUser: jest.fn(), deleteUser: jest.fn(), listUsers: jest.fn() } },
};

jest.mock("../../config/supabase", () => mockClient);

const { createSignupAccount } = require("../../model/userModel");

const input = { accountType: "ORGANISER", name: "Synthetic Organiser", email: "eo@connectsphere.test", password: "Passw0rdOK" };
const authUser = (overrides = {}) => ({
  id: "auth-1",
  email: "eo@connectsphere.test",
  app_metadata: { signup_account_type: "ORGANISER" },
  created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  ...overrides,
});
const authError = (status, code) => ({ status, code, name: "AuthApiError", message: code });

// from("user") is used for insert (sign-up) and for the orphan lookup.
const mockUserTable = ({ insertResult, lookupResult = { data: null, error: null } }) => {
  const insertChain = { select: jest.fn().mockReturnThis(), single: jest.fn().mockResolvedValue(insertResult) };
  const lookupChain = { eq: jest.fn().mockReturnThis(), maybeSingle: jest.fn().mockResolvedValue(lookupResult) };
  const table = { insert: jest.fn(() => insertChain), select: jest.fn(() => lookupChain) };
  mockClient.from.mockReturnValue(table);
  return table;
};

const profileRow = { user_id: 42, email: input.email, name: input.name, role: "ORGANISER" };

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockClient.auth.admin.deleteUser.mockResolvedValue({ data: {}, error: null });
});

describe("[SPM-123 AC1] successful sign-up", () => {
  test("should_create_a_confirmed_auth_account_marked_as_signup_when_details_are_valid", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: authUser() }, error: null });
    mockUserTable({ insertResult: { data: profileRow, error: null } });

    await createSignupAccount(input);

    expect(mockClient.auth.admin.createUser).toHaveBeenCalledWith({
      email: input.email,
      password: input.password,
      email_confirm: true,
      app_metadata: { signup_account_type: "ORGANISER" },
    });
  });

  test("should_insert_an_active_profile_linked_by_auth_user_id_with_the_validated_role", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: authUser() }, error: null });
    const table = mockUserTable({ insertResult: { data: profileRow, error: null } });

    const profile = await createSignupAccount(input);

    expect(table.insert).toHaveBeenCalledWith({
      email: input.email,
      name: input.name,
      role: "ORGANISER",
      auth_user_id: "auth-1",
      is_active: true,
    });
    expect(profile).toEqual(profileRow);
    expect(mockClient.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  test("should_never_store_the_password_in_the_profile_when_inserting", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: authUser() }, error: null });
    const table = mockUserTable({ insertResult: { data: profileRow, error: null } });

    await createSignupAccount(input);

    expect(JSON.stringify(table.insert.mock.calls[0][0])).not.toContain(input.password);
  });
});

describe("[SPM-123 AC2] duplicate email", () => {
  test("should_throw_email_unavailable_without_touching_profiles_when_auth_email_exists", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: null }, error: authError(422, "email_exists") });
    mockClient.auth.admin.listUsers.mockResolvedValue({ data: { users: [authUser({ app_metadata: {} })] }, error: null });
    const table = mockUserTable({ insertResult: { data: null, error: null } });

    await expect(createSignupAccount(input)).rejects.toMatchObject({ name: "SignupError", code: "EMAIL_UNAVAILABLE" });
    expect(table.insert).not.toHaveBeenCalled();
    expect(mockClient.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  test("should_delete_the_new_auth_account_and_throw_email_unavailable_when_a_profile_already_has_the_email", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: authUser() }, error: null });
    mockUserTable({ insertResult: { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } } });

    await expect(createSignupAccount(input)).rejects.toMatchObject({ code: "EMAIL_UNAVAILABLE" });
    expect(mockClient.auth.admin.deleteUser).toHaveBeenCalledWith("auth-1");
  });
});

describe("[TC-AUTH-026] partial-failure compensation", () => {
  test("should_delete_the_new_auth_account_and_rethrow_when_the_profile_insert_fails", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: authUser() }, error: null });
    mockUserTable({ insertResult: { data: null, error: { code: "42501", message: "permission denied for table user" } } });

    await expect(createSignupAccount(input)).rejects.toThrow("permission denied");
    expect(mockClient.auth.admin.deleteUser).toHaveBeenCalledWith("auth-1");
  });

  test("should_log_the_auth_user_id_without_the_password_when_compensation_also_fails", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: authUser() }, error: null });
    mockUserTable({ insertResult: { data: null, error: { code: "42501", message: "denied" } } });
    mockClient.auth.admin.deleteUser.mockResolvedValue({ data: null, error: authError(500, "unexpected_failure") });

    await expect(createSignupAccount(input)).rejects.toThrow();
    const logged = JSON.stringify(console.error.mock.calls);
    expect(logged).toContain("auth-1");
    expect(logged).not.toContain(input.password);
  });

  test("should_remove_a_stale_orphaned_signup_account_and_retry_when_email_exists_without_a_profile", async () => {
    mockClient.auth.admin.createUser
      .mockResolvedValueOnce({ data: { user: null }, error: authError(422, "email_exists") })
      .mockResolvedValueOnce({ data: { user: authUser({ id: "auth-2" }) }, error: null });
    mockClient.auth.admin.listUsers.mockResolvedValue({ data: { users: [authUser({ id: "orphan-1" })] }, error: null });
    mockUserTable({ insertResult: { data: profileRow, error: null }, lookupResult: { data: null, error: null } });

    await expect(createSignupAccount(input)).resolves.toEqual(profileRow);
    expect(mockClient.auth.admin.deleteUser).toHaveBeenCalledWith("orphan-1");
    expect(mockClient.auth.admin.createUser).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["has a linked profile", authUser(), { data: { user_id: 7 }, error: null }],
    ["was not created by sign-up", authUser({ app_metadata: {} }), { data: null, error: null }],
    ["is younger than two minutes", authUser({ created_at: new Date().toISOString() }), { data: null, error: null }],
  ])("should_keep_the_existing_auth_account_when_it_%s", async (_label, existing, lookupResult) => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: null }, error: authError(422, "email_exists") });
    mockClient.auth.admin.listUsers.mockResolvedValue({ data: { users: [existing] }, error: null });
    mockUserTable({ insertResult: { data: null, error: null }, lookupResult });

    await expect(createSignupAccount(input)).rejects.toMatchObject({ code: "EMAIL_UNAVAILABLE" });
    expect(mockClient.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});

describe("[SPM-123] Supabase error mapping", () => {
  test.each([
    ["weak_password", 422, "WEAK_PASSWORD"],
    ["validation_failed", 400, "INVALID_SIGNUP_DETAILS"],
    ["email_address_invalid", 400, "INVALID_SIGNUP_DETAILS"],
  ])("should_map_%s_to_%s", async (code, status, expected) => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: null }, error: authError(status, code) });

    await expect(createSignupAccount(input)).rejects.toMatchObject({ name: "SignupError", code: expected });
  });

  test("should_throw_a_generic_error_when_supabase_auth_fails_and_no_account_exists", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: null }, error: authError(500, "unexpected_failure") });
    mockClient.auth.admin.listUsers.mockResolvedValue({ data: { users: [] }, error: null });

    await expect(createSignupAccount(input)).rejects.toThrow("[Supabase Auth Error] 500 unexpected_failure");
  });

  test("[TC-AUTH-028] should_throw_email_unavailable_when_a_5xx_follows_a_parallel_request_that_won_the_race", async () => {
    mockClient.auth.admin.createUser.mockResolvedValue({ data: { user: null }, error: authError(500, "unexpected_failure") });
    mockClient.auth.admin.listUsers.mockResolvedValue({ data: { users: [authUser({ id: "winner" })] }, error: null });
    const table = mockUserTable({ insertResult: { data: null, error: null } });

    await expect(createSignupAccount(input)).rejects.toMatchObject({ code: "EMAIL_UNAVAILABLE" });
    expect(table.insert).not.toHaveBeenCalled();
    expect(mockClient.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});
