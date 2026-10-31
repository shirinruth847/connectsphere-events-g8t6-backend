const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validatePagination, validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");
const {
  getVenueCatalogue,
  getRequestVenueOptions,
  getRequestVenueAvailability,
  listSelectableVenuePhotos,
  getSelectableVenuePhotoImage,
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
  getEventBookingHistory,
  getVenueHistory,
  getBookingAvailability,
  listHoldRequests,
  placeVenueHold,
  declineHoldRequest,
  withdrawHoldRequest,
  extendVenueHold,
  releaseVenueHold,
  approveVenueBooking,
  rejectVenueBooking,
  listVenuePhotos,
  getVenuePhotoImage,
  addVenuePhoto,
  updateVenuePhoto,
  replaceVenuePhotoImage,
  deleteVenuePhoto,
  listVenueBlocks,
  createVenueBlock,
  shortenVenueBlock,
  liftVenueBlock,
  restoreVenueIncident,
} = require("../controller/venueController");
const { PHOTO_TYPES } = require("../validators/venuePhotoValidator");

const venueStaffOnly = [requireAuth, requireRole("VENUE_STAFF")];
// Image bytes for the gallery, read only after authentication and the role check.
// A larger body is answered 413 by the error handler; 2 MB is the per-photo limit.
const imageBody = express.raw({ type: PHOTO_TYPES, limit: "2mb" });

// Read-only catalogue of available venues. Coordinators and Leads browse venues
// inside each event instead (GET /api/events/:id/venue-options, SPM-72/74).
router.get("/", ...venueStaffOnly, getVenueCatalogue);

// The organiser's venue step (SPM-76): available venues checked against the
// unsaved request, and one venue's calendar showing busy periods by kind only.
// Read-only photos of available venues serve everyone who chooses venues:
// organisers here, coordinators and Leads in the event's venue section
// (SPM-72/74). Declared before /:venueId.
const organiserOnly = [requireAuth, requireRole(USER_ROLES.ORGANISER)];
router.get("/options", ...organiserOnly, getRequestVenueOptions);
router.get("/options/:venueId/availability", ...organiserOnly, getRequestVenueAvailability);
const venueChoosers = [requireAuth, requireRole(USER_ROLES.ORGANISER, USER_ROLES.COORDINATOR, USER_ROLES.COORDINATOR_LEAD)];
router.get("/options/:venueId/photos", ...venueChoosers, listSelectableVenuePhotos);
router.get("/options/:venueId/photos/:photoId", ...venueChoosers, getSelectableVenuePhotoImage);

// Availability calendar (SPM-74): Event Coordinators and Venue Staff only;
// declared before /:venueId.
router.get("/availability", requireAuth, requireRole("COORDINATOR", "VENUE_STAFF"), getVenueAvailability);

// Venue booking review (SPM-181); declared before /:venueId.
router.get("/bookings", ...venueStaffOnly, listVenueBookings);
router.get("/bookings/events/:eventId", ...venueStaffOnly, getEventVenueBookings);
// The venue-relevant part of the event's history (SPM-186).
router.get("/bookings/events/:eventId/history", ...venueStaffOnly, validateCursorPagination, getEventBookingHistory);
router.get("/bookings/:bookingId", ...venueStaffOnly, getVenueBooking);
// Tentative holds (SPM-190); declared before /:venueId.
router.get("/hold-requests", ...venueStaffOnly, listHoldRequests);
router.post("/hold-requests/:requestId/place", ...venueStaffOnly, placeVenueHold);
router.post("/hold-requests/:requestId/decline", ...venueStaffOnly, declineHoldRequest);
// The coordinator withdraws their own request; the database checks the relationship.
router.post("/hold-requests/:requestId/withdraw", requireAuth, requireRole(USER_ROLES.COORDINATOR), withdrawHoldRequest);
router.post("/holds/:holdId/extend", ...venueStaffOnly, extendVenueHold);
// Venue Staff, or the event's assigned coordinator (checked by the database).
router.post("/holds/:holdId/release", requireAuth, requireRole(USER_ROLES.VENUE_STAFF, USER_ROLES.COORDINATOR), releaseVenueHold);

// The booking's venue calendar with its own window as the checked period (SPM-186).
router.get("/bookings/:bookingId/availability", ...venueStaffOnly, getBookingAvailability);
// One booking per decision; there is no bulk decision (SPM-186 AC6).
router.post("/bookings/:bookingId/approve", ...venueStaffOnly, approveVenueBooking);
router.post("/bookings/:bookingId/reject", ...venueStaffOnly, rejectVenueBooking);

// Restoring a booking after a block (SPM-195); declared before /:venueId.
router.post("/incidents/:incidentId/restore", ...venueStaffOnly, restoreVenueIncident);

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
// The venue's own change history (SPM-186).
router.get("/:venueId/history", ...venueStaffOnly, validateCursorPagination, getVenueHistory);

// Operational blocks in the MongoDB venue calendar (SPM-195, Master 5.4.4).
router.get("/:venueId/blocks", ...venueStaffOnly, listVenueBlocks);
router.post("/:venueId/blocks", ...venueStaffOnly, createVenueBlock);
router.put("/:venueId/blocks/:blockId", ...venueStaffOnly, shortenVenueBlock);
router.post("/:venueId/blocks/:blockId/lift", ...venueStaffOnly, liftVenueBlock);

// Photo gallery in MongoDB (T28): Venue Staff upload, edit and delete.
router.get("/:venueId/photos", ...venueStaffOnly, listVenuePhotos);
router.post("/:venueId/photos", ...venueStaffOnly, imageBody, addVenuePhoto);
router.get("/:venueId/photos/:photoId", ...venueStaffOnly, getVenuePhotoImage);
router.put("/:venueId/photos/:photoId", ...venueStaffOnly, updateVenuePhoto);
router.put("/:venueId/photos/:photoId/image", ...venueStaffOnly, imageBody, replaceVenuePhotoImage);
router.delete("/:venueId/photos/:photoId", ...venueStaffOnly, deleteVenuePhoto);

module.exports = router;
