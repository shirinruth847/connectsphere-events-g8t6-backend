const healthCheck = require("../model/healthModel");
const { revokeSession, createSignupAccount } = require("../model/userModel");
const { getBearerToken } = require("../middleware/auth");
const { ROLE_HOME_PATHS } = require("../config/roles");
const { validateSignup, normaliseSignup, MESSAGES } = require("../validators/authValidator");

// One answer whether the email belongs to an account or a profile not yet
// linked to Auth, so the response never confirms that an account exists.
const EMAIL_UNAVAILABLE = { error: "The email cannot be used for registration.", code: "EMAIL_UNAVAILABLE" };

const validationFailed = (res, fields) =>
  res.status(400).json({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });

// roles is a list so the contract survives multi-role users (Master 3.1);
// the schema currently stores exactly one role per user.
const toAuthenticatedUser = (user) => ({
  user_id: user.user_id,
  email: user.email,
  name: user.name,
  role: user.role,
  roles: [user.role],
  home_path: ROLE_HOME_PATHS[user.role],
});

const test = async (req, res, next) => {
  try {
    const msg = await healthCheck(); // ✅ await the async function
    res.status(200).json({ message: msg });
  } catch (error) {
    return next(error);
  }
};

// The browser signs in with Supabase Auth and then calls this route. A 401
// here (no active ConnectSphere profile) tells the browser to sign out again.
const getCurrentUser = async (req, res) => {
  res.status(200).json({ user: toAuthenticatedUser(req.user) });
};

// Self sign-up for ATTENDEE and ORGANISER only. No session is returned: the
// browser signs in with Supabase Auth afterwards, exactly as for login.
const signup = async (req, res, next) => {
  res.set("Cache-Control", "no-store");

  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return validationFailed(res, { body: "Send the sign-up details as a JSON object." });
    }

    const fields = validateSignup(body);
    if (Object.keys(fields).length > 0) {
      return validationFailed(res, fields);
    }

    const profile = await createSignupAccount(normaliseSignup(body));
    return res.status(201).json({ message: "Account created. You can now log in.", user: toAuthenticatedUser(profile) });
  } catch (error) {
    if (error.name === "SignupError") {
      if (error.code === "EMAIL_UNAVAILABLE") return res.status(409).json(EMAIL_UNAVAILABLE);
      if (error.code === "WEAK_PASSWORD") return validationFailed(res, { password: MESSAGES.passwordRequirements });
      if (error.code === "INVALID_SIGNUP_DETAILS") return validationFailed(res, { email: MESSAGES.emailInvalid });
    }
    return next(error);
  }
};

// Idempotent: an absent, expired or already-revoked token still logs out.
const logout = async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const accessToken = getBearerToken(req);
    if (accessToken) {
      await revokeSession(accessToken);
    }
    res.status(204).end();
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

module.exports = { test, getCurrentUser, logout, signup };
