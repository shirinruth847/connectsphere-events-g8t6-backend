const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { getVenueCatalogue } = require("../controller/venueController");

router.get(
  "/",
  requireAuth,
  requireRole("COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "SAFETY_OFFICER"),
  getVenueCatalogue
);

module.exports = router;
