const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { getVenueCatalogue } = require("../controller/venueController");

// SAFETY_OFFICER joins this list once its ticket adds the role to user_role.
router.get(
  "/",
  requireAuth,
  requireRole("COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF"),
  getVenueCatalogue
);

module.exports = router;
