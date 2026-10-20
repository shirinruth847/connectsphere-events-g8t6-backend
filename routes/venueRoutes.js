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
  updateVenueDetails,
  getVenueAvailability,
  listVenueBookings,
  getVenueBooking,
  getEventVenueBookings,
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

// Availability calendar (SPM-74): Event Coordinators and Venue Staff only;
// declared before /:venueId.
router.get("/availability", requireAuth, requireRole("COORDINATOR", "VENUE_STAFF"), getVenueAvailability);

// Venue booking review (SPM-181); declared before /:venueId.
router.get("/bookings", ...venueStaffOnly, listVenueBookings);
router.get("/bookings/events/:eventId", ...venueStaffOnly, getEventVenueBookings);
router.get("/bookings/:bookingId", ...venueStaffOnly, getVenueBooking);

// Venue maintenance (SPM-73). /manage is declared before /:venueId.
router.get("/manage", ...venueStaffOnly, validatePagination, listManagedVenues);
router.get("/:venueId", ...venueStaffOnly, getManagedVenue);
router.post("/", ...venueStaffOnly, createVenue);
router.put("/:venueId", ...venueStaffOnly, updateVenue);
router.put("/:venueId/status", ...venueStaffOnly, changeVenueStatus);
// MongoDB details, including setup/turnaround minutes (Master 6.4, T27).
router.put("/:venueId/details", ...venueStaffOnly, updateVenueDetails);

module.exports = router;
