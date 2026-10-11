const {
  validateSignup,
  normaliseSignup,
  MESSAGES,
  PASSWORD_REQUIREMENTS,
} = require("../../validators/authValidator");

const validInput = (overrides = {}) => ({
  accountType: "ATTENDEE",
  name: "Synthetic Attendee",
  email: "attendee@connectsphere.test",
  password: "Passw0rdOK",
  ...overrides,
});

describe("[SPM-123 AC1] validateSignup accepts valid details", () => {
  test.each(["ATTENDEE", "ORGANISER"])("should_return_no_errors_when_account_type_is_%s", (accountType) => {
    expect(validateSignup(validInput({ accountType }))).toEqual({});
  });

  test("should_accept_boundary_lengths_when_values_are_exactly_at_the_limits", () => {
    const local = "a".repeat(150 - "@connectsphere.test".length);
    expect(validateSignup(validInput({
      name: "n".repeat(100),
      email: `${local}@connectsphere.test`,
      password: `A1${"x".repeat(70)}`,
    }))).toEqual({});
  });
});

describe("[SPM-123 AC3] required fields", () => {
  test.each([
    ["accountType", MESSAGES.accountTypeRequired],
    ["name", MESSAGES.nameRequired],
    ["email", MESSAGES.emailRequired],
    ["password", MESSAGES.passwordRequired],
  ])("should_report_only_%s_when_it_is_missing", (field, message) => {
    const input = validInput();
    delete input[field];

    expect(validateSignup(input)).toEqual({ [field]: message });
  });

  test.each([[""], ["   "], [null]])("should_treat_%j_as_missing_when_name_is_blank", (name) => {
    expect(validateSignup(validInput({ name }))).toEqual({ name: MESSAGES.nameRequired });
  });

  test("should_report_every_required_field_when_body_is_empty", () => {
    expect(validateSignup({})).toEqual({
      accountType: MESSAGES.accountTypeRequired,
      name: MESSAGES.nameRequired,
      email: MESSAGES.emailRequired,
      password: MESSAGES.passwordRequired,
    });
  });
});

describe("[SPM-123 AC1] account type allowlist", () => {
  test.each(["COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT", "attendee", "ADMIN", "ATTENDEE,ORGANISER"])(
    "should_reject_account_type_when_it_is_%s",
    (accountType) => {
      expect(validateSignup(validInput({ accountType }))).toEqual({ accountType: MESSAGES.accountTypeInvalid });
    },
  );

  test.each([[["ATTENDEE"]], [{ role: "ATTENDEE" }], [1]])("should_reject_account_type_when_it_is_not_text_%j", (accountType) => {
    expect(validateSignup(validInput({ accountType }))).toEqual({ accountType: MESSAGES.accountTypeInvalid });
  });
});

describe("[TC-AUTH-025] server-controlled fields", () => {
  test.each(["role", "roles", "user_id", "userId", "auth_user_id", "authUserId", "organisation_id", "organisationId", "is_active"])(
    "should_reject_%s_when_client_sends_it",
    (field) => {
      expect(validateSignup(validInput({ [field]: "COORDINATOR" }))).toEqual({ [field]: MESSAGES.fieldNotAllowed });
    },
  );

  test("should_report_a___proto___key_as_a_rejected_field", () => {
    const input = JSON.parse('{"accountType":"ATTENDEE","name":"N","email":"a@connectsphere.test","password":"Passw0rdOK","__proto__":{"role":"COORDINATOR"}}');

    const errors = validateSignup(input);

    expect(Object.prototype.hasOwnProperty.call(errors, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(errors)).toBe(Object.prototype);
  });
});

describe("[SPM-123 AC5] email format", () => {
  test.each([
    "plainaddress",
    "missing-domain@",
    "@missing-local.test",
    "no-dot@domain",
    "two@@connectsphere.test",
    "has space@connectsphere.test",
    "trailing-dot@connectsphere.",
  ])("should_return_format_error_when_email_is_%s", (email) => {
    expect(validateSignup(validInput({ email }))).toEqual({ email: MESSAGES.emailInvalid });
  });

  test("should_return_format_error_when_email_exceeds_150_characters", () => {
    const email = `${"a".repeat(151 - "@connectsphere.test".length)}@connectsphere.test`;
    expect(validateSignup(validInput({ email }))).toEqual({ email: MESSAGES.emailInvalid });
  });

  test("should_accept_surrounding_spaces_when_email_is_otherwise_valid", () => {
    expect(validateSignup(validInput({ email: "  Mixed.Case@ConnectSphere.test " }))).toEqual({});
  });
});

describe("[SPM-123 AC4] password policy", () => {
  test.each([
    ["7 characters", "Abcde12"],
    ["letters only", "OnlyLetters"],
    ["digits only", "1234567890"],
    ["73 characters", `A1${"x".repeat(71)}`],
    ["not text", 12345678],
  ])("should_explain_the_requirements_when_password_has_%s", (_label, password) => {
    expect(validateSignup(validInput({ password }))).toEqual({ password: PASSWORD_REQUIREMENTS });
  });

  test("should_state_length_and_complexity_in_the_requirements_message", () => {
    expect(PASSWORD_REQUIREMENTS).toBe("Password must be 8 to 72 characters and include at least one letter and one number.");
  });

  test("should_accept_8_characters_when_password_has_a_letter_and_a_digit", () => {
    expect(validateSignup(validInput({ password: "abcdefg1" }))).toEqual({});
  });
});

describe("[SPM-123] normaliseSignup", () => {
  test("should_trim_and_lowercase_email_and_keep_password_exactly_when_normalising", () => {
    expect(normaliseSignup(validInput({
      accountType: " ORGANISER ",
      name: "  Synthetic Organiser ",
      email: " Mixed.Case@ConnectSphere.TEST ",
      password: " Passw0rd with spaces ",
    }))).toEqual({
      accountType: "ORGANISER",
      name: "Synthetic Organiser",
      email: "mixed.case@connectsphere.test",
      password: " Passw0rd with spaces ",
    });
  });
});
