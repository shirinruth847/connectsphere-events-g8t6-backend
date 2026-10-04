const healthCheck = require("../model/healthModel");
const { authenticateWithPassword, findUserByAuthId, revokeSession } = require("../model/userModel");
const { getBearerToken } = require("../middleware/auth");
const { ROLE_HOME_PATHS } = require("../config/roles");

// One message for every rejected login, so responses never reveal whether
// the account exists, the password was wrong or the profile is inactive.
const INVALID_CREDENTIALS = { error: "Invalid email or password.", code: "INVALID_CREDENTIALS" };

const toAuthenticatedUser = (user) => ({
  user_id: user.user_id,
  email: user.email,
  name: user.name,
  role: user.role,
  home_path: ROLE_HOME_PATHS[user.role],
});

const test = async (req, res) => {
  try {
    const msg = await healthCheck(); // ✅ await the async function
    res.status(200).json({ message: msg });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

const login = async (req, res) => {
  res.set("Cache-Control", "no-store");

  try {
    const session = await authenticateWithPassword(req.body.email, req.body.password);
    if (!session) {
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    const user = await findUserByAuthId(session.user.id);
    if (!user) {
      // Auth accepted the password but there is no active ConnectSphere
      // profile, so discard the new session instead of handing it out.
      await revokeSession(session.access_token);
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    return res.status(200).json({
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        token_type: session.token_type,
        expires_in: session.expires_in,
        expires_at: session.expires_at,
      },
      user: toAuthenticatedUser(user),
    });
  } catch (error) {
    if (error.code === "AUTH_RATE_LIMITED") {
      return res.status(429).json({ error: "Too many sign-in attempts. Please wait and try again.", code: "RATE_LIMITED" });
    }
    console.error("Error:", error);
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

const getCurrentUser = async (req, res) => {
  res.status(200).json({ user: toAuthenticatedUser(req.user) });
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

module.exports = { test, login, getCurrentUser, logout };
