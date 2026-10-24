const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validatePagination } = require("../middleware/validate");
const {
  getVenueCatalogue,
  listManagedVenues,
  listVenueOptions,
  getManagedVenue,
  createVenue,
  updateVenue,
  changeVenueStatus,
  updateVenueDetails,
  getVenueAvailability,
  listVenueBookings,
  getVenueBooking,
  getEventVenueBookings,
  listVenuePhotos,
  getVenuePhotoImage,
  addVenuePhoto,
  updateVenuePhoto,
  replaceVenuePhotoImage,
  deleteVenuePhoto,
} = require("../controller/venueController");
const { PHOTO_TYPES } = require("../validators/venuePhotoValidator");

const venueStaffOnly = [requireAuth, requireRole("VENUE_STAFF")];
// Image bytes for the gallery, read only after authentication and the role check.
// A larger body is answered 413 by the error handler; 2 MB is the per-photo limit.
const imageBody = express.raw({ type: PHOTO_TYPES, limit: "2mb" });

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
// Every non-deleted venue, for My Requests filters and pickers (SPM-181).
router.get("/manage/options", ...venueStaffOnly, listVenueOptions);
router.get("/:venueId", ...venueStaffOnly, getManagedVenue);
router.post("/", ...venueStaffOnly, createVenue);
router.put("/:venueId", ...venueStaffOnly, updateVenue);
router.put("/:venueId/status", ...venueStaffOnly, changeVenueStatus);
// MongoDB details, including setup/turnaround minutes (Master 6.4, T27).
router.put("/:venueId/details", ...venueStaffOnly, updateVenueDetails);

// Photo gallery in MongoDB (T28): Venue Staff upload, edit and delete.
router.get("/:venueId/photos", ...venueStaffOnly, listVenuePhotos);
router.post("/:venueId/photos", ...venueStaffOnly, imageBody, addVenuePhoto);
router.get("/:venueId/photos/:photoId", ...venueStaffOnly, getVenuePhotoImage);
router.put("/:venueId/photos/:photoId", ...venueStaffOnly, updateVenuePhoto);
router.put("/:venueId/photos/:photoId/image", ...venueStaffOnly, imageBody, replaceVenuePhotoImage);
router.delete("/:venueId/photos/:photoId", ...venueStaffOnly, deleteVenuePhoto);

module.exports = router;
