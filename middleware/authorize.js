const { UNAUTHENTICATED } = require("./auth");

const FORBIDDEN = { error: "You do not have permission to access this resource.", code: "FORBIDDEN" };

// Usage: requireRole("ORGANISER") or requireRole("COORDINATOR", "ORGANISER").
// Must run after requireAuth, which loads the trusted role from the database.
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json(UNAUTHENTICATED);
  }
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json(FORBIDDEN);
  }
  return next();
};

module.exports = { requireRole };
