const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validatePagination } = require("../middleware/validate");
const {
  getVenueCatalogue,
  listManagedVenues,
  getManagedVenue,
  createVenue,
  updateVenue,
  changeVenueStatus,
} = require("../controller/venueController");

const venueStaffOnly = [requireAuth, requireRole("VENUE_STAFF")];

// Read-only catalogue of available venues (SPM-72).
// SAFETY_OFFICER joins this list once its ticket adds the role to user_role.
router.get(
  "/",
  requireAuth,
  requireRole("COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF"),
  getVenueCatalogue
);

// Venue maintenance (SPM-73). /manage is declared before /:venueId.
router.get("/manage", ...venueStaffOnly, validatePagination, listManagedVenues);
router.get("/:venueId", ...venueStaffOnly, getManagedVenue);
router.post("/", ...venueStaffOnly, createVenue);
router.put("/:venueId", ...venueStaffOnly, updateVenue);
router.put("/:venueId/status", ...venueStaffOnly, changeVenueStatus);

module.exports = router;
