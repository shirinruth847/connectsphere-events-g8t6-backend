const healthCheck = require("../model/healthModel");
const { revokeSession } = require("../model/userModel");
const { getBearerToken } = require("../middleware/auth");
const { ROLE_HOME_PATHS } = require("../config/roles");

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

module.exports = { test, getCurrentUser, logout };
