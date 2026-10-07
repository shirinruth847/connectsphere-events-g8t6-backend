const { verifyAccessToken, findUserByAuthId } = require("../model/userModel");

const UNAUTHENTICATED = { error: "Please log in to continue.", code: "UNAUTHENTICATED" };

const getBearerToken = (req) => {
  const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
  return match ? match[1] : null;
};

// Frontend sends: Authorization: Bearer <Supabase access token>
const requireAuth = async (req, res, next) => {
  // Authenticated data must not be served from the browser cache after logout.
  res.set("Cache-Control", "no-store");

  try {
    const accessToken = getBearerToken(req);
    if (!accessToken) {
      return res.status(401).json(UNAUTHENTICATED);
    }

    const authUserId = await verifyAccessToken(accessToken);
    if (!authUserId) {
      return res.status(401).json(UNAUTHENTICATED);
    }

    // Roles and memberships come from the database, never from token metadata.
    const user = await findUserByAuthId(authUserId);
    if (!user) {
      return res.status(401).json(UNAUTHENTICATED);
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = { requireAuth, getBearerToken, UNAUTHENTICATED };
