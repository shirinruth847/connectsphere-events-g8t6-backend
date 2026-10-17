const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { getVenueCatalogue, addVenue, updateVenue } = require("../controller/venueController");

router.get("/", requireAuth, requireRole("COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "SAFETY_OFFICER"), getVenueCatalogue);
router.post("/", requireAuth, requireRole("VENUE_STAFF"), addVenue);
router.put("/:venueId", requireAuth, requireRole("VENUE_STAFF"), updateVenue);

module.exports = router;
