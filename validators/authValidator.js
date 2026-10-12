// Pure sign-up validation (no database access) so it is easy to unit test.
// Returns { fieldName: errorMessage }; an empty object means valid.
// Limits match the public.user columns, so accepted input is always storable.
const { USER_ROLES } = require("../config/roles");

// Only these roles may be chosen at sign-up; staff roles need trusted provisioning (Master 3.1).
const SELF_SIGNUP_ROLES = Object.freeze([USER_ROLES.ATTENDEE, USER_ROLES.ORGANISER]);

const SIGNUP_FIELDS = Object.freeze(["accountType", "name", "email", "password"]);

const MAX_NAME_LENGTH = 100; // user.name varchar(100)
const MAX_EMAIL_LENGTH = 150; // user.email varchar(150)
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72; // Supabase Auth rejects longer passwords

// Deliberately simple: one @, no spaces, a dot in the domain. Supabase Auth
// performs its own stricter check when the account is created.
const EMAIL_FORMAT = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const PASSWORD_REQUIREMENTS =
  `Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters and include at least one letter and one number.`;

const MESSAGES = Object.freeze({
  accountTypeRequired: "Account type is required.",
  accountTypeInvalid: "Choose Attendee or Event Organiser.",
  nameRequired: "Name is required.",
  nameTooLong: `Name must be ${MAX_NAME_LENGTH} characters or fewer.`,
  emailRequired: "Email is required.",
  emailInvalid: "Enter a valid email address.",
  passwordRequired: "Password is required.",
  passwordRequirements: PASSWORD_REQUIREMENTS,
  textInvalid: "Please enter text.",
  fieldNotAllowed: "This field cannot be set.",
});

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const meetsPasswordPolicy = (password) =>
  password.length >= MIN_PASSWORD_LENGTH &&
  password.length <= MAX_PASSWORD_LENGTH &&
  /[A-Za-z]/.test(password) &&
  /\d/.test(password);

// Fields outside the allowlist (role, userId, authUserId, organisationId, ...)
// are rejected rather than ignored, so a client never believes they were applied.
const getUnsupportedSignupFields = (body) => Object.keys(body).filter((field) => !SIGNUP_FIELDS.includes(field));

const validateSignup = (input = {}) => {
  // Object.fromEntries keeps a client-sent "__proto__" key as plain data.
  const errors = Object.fromEntries(
    getUnsupportedSignupFields(input)
      .slice(0, 10)
      .map((field) => [field.slice(0, 60), MESSAGES.fieldNotAllowed])
  );

  if (isBlank(input.accountType)) {
    errors.accountType = MESSAGES.accountTypeRequired;
  } else if (typeof input.accountType !== "string" || !SELF_SIGNUP_ROLES.includes(input.accountType.trim())) {
    errors.accountType = MESSAGES.accountTypeInvalid;
  }

  if (isBlank(input.name)) {
    errors.name = MESSAGES.nameRequired;
  } else if (typeof input.name !== "string") {
    errors.name = MESSAGES.textInvalid;
  } else if (input.name.trim().length > MAX_NAME_LENGTH) {
    errors.name = MESSAGES.nameTooLong;
  }

  if (isBlank(input.email)) {
    errors.email = MESSAGES.emailRequired;
  } else if (
    typeof input.email !== "string" ||
    input.email.trim().length > MAX_EMAIL_LENGTH ||
    !EMAIL_FORMAT.test(input.email.trim())
  ) {
    errors.email = MESSAGES.emailInvalid;
  }

  // Not trimmed: surrounding spaces may be part of the password.
  if (input.password === undefined || input.password === null || input.password === "") {
    errors.password = MESSAGES.passwordRequired;
  } else if (typeof input.password !== "string" || !meetsPasswordPolicy(input.password)) {
    errors.password = MESSAGES.passwordRequirements;
  }

  return errors;
};

// Called only after validateSignup passes.
const normaliseSignup = (input) => ({
  accountType: input.accountType.trim(),
  name: input.name.trim(),
  email: input.email.trim().toLowerCase(),
  password: input.password,
});

module.exports = {
  validateSignup,
  normaliseSignup,
  getUnsupportedSignupFields,
  SELF_SIGNUP_ROLES,
  MESSAGES,
  PASSWORD_REQUIREMENTS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
};
