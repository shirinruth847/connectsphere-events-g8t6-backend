const express = require("express");
const router = express.Router();

const {
  createAndSubmit,
  getRequestOptions,
  createDraft,
  updateDraft,
  updateEventDetails,
  submitDraft,
  listMyEventRequests,
  listAttendeeDiscovery,
  getAttendeeEventDetail,
  getEventRequest,
  getEventHistory,
  getEventClarifications,
  markEventHistoryViewed,
  requestClarification,
  postClarificationMessage,
  saveClarificationAmendments,
  completeClarification,
  markClarificationRead,
  listAssignedEvents,
  patchCoordinator,
  assignCoordinatorAsLead,
  listLeadAssignments,
  listUnassignedEvents,
  getCoordinatorAvailability,
  getEventReadiness,
  acceptFeasibility,
  rejectSubmittedEvent,
  submitForSafetyReview,
  confirmEvent,
  startPreparation,
  completeEvent,
} = require("../controller/eventController");
const { getEventSafetyReviews } = require("../controller/safetyController");
const {
  getEventVenueOptions,
  getEventVenueAvailability,
  suggestEventVenue,
  requestVenueBookings,
  listEventVenueBookings,
  checkVenueBookings,
  requestVenueHold,
  listEventHolds,
} = require("../controller/venueController");
const { requireAuth } = require("../middleware/auth");
const { requireRole, requireVisibleEvent } = require("../middleware/authorize");
const { validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");
const { getOrganiserArrangements } = require("../controller/organiserArrangementController");

// Applied per route (not router-wide) so coordinator routes can be added here later.
const organiserOnly = [requireAuth, requireRole(USER_ROLES.ORGANISER)];
const coordinatorOnly = [requireAuth, requireRole(USER_ROLES.COORDINATOR)];
const leadOnly = [requireAuth, requireRole(USER_ROLES.COORDINATOR_LEAD)];
const attendeeOnly = [requireAuth, requireRole(USER_ROLES.ATTENDEE)];
// No role gate on these: requireVisibleEvent answers "not found" unless the event is
// inside the user's viewing scope, rather than a role error that confirms it exists
// (SPM-33). It runs last in each chain, so earlier checks keep their precedence.
const anySignedInUser = [requireAuth];
// SPM-173 lifecycle actions: the assigned coordinator only; any other coordinator
// gets "not found" from requireVisibleEvent.
const assignedCoordinatorOnly = [...coordinatorOnly, requireVisibleEvent];

// GET / is left free for event discovery (Master section 3.4).
router.post("/", organiserOnly, createAndSubmit);
router.post("/drafts", organiserOnly, createDraft);
router.get("/request-options", organiserOnly, getRequestOptions);
router.get("/mine", organiserOnly, validateCursorPagination, listMyEventRequests); // must stay above "/:id"
router.get("/discovery", attendeeOnly, validateCursorPagination, listAttendeeDiscovery);
router.get("/discovery/:id", attendeeOnly, getAttendeeEventDetail);
// Completed Lead workflows are available without a rollout opt-in. Access is
// still enforced through verified authentication and the trusted Lead role.
router.get("/unassigned", leadOnly, listUnassignedEvents); // must stay above "/:id"
router.get("/coordinator-availability", leadOnly, getCoordinatorAvailability); // Lead-only cross-coordinator schedule
router.get("/assignments", leadOnly, listLeadAssignments); // must stay above "/:id"
router.post("/:id/coordinator", leadOnly, assignCoordinatorAsLead);
router.patch("/:id/coordinator", leadOnly, patchCoordinator);
router.get("/assigned", coordinatorOnly, listAssignedEvents); // must stay above "/:id"
router.post("/:id/reject", assignedCoordinatorOnly, rejectSubmittedEvent);
router.get("/:id/readiness", assignedCoordinatorOnly, getEventReadiness);
router.post("/:id/accept-feasibility", assignedCoordinatorOnly, acceptFeasibility);
router.post("/:id/submit-for-safety-review", assignedCoordinatorOnly, submitForSafetyReview);
router.post("/:id/confirm", assignedCoordinatorOnly, confirmEvent);
router.post("/:id/start-preparation", assignedCoordinatorOnly, startPreparation);
router.post("/:id/complete", assignedCoordinatorOnly, completeEvent);
// Venue section of the event (SPM-72/74): the assigned coordinator and the
// supervising Lead browse; only the coordinator suggests a venue. Photos are
// read through GET /api/venues/options/:venueId/photos.
const eventVenueReaders = [requireAuth, requireRole(USER_ROLES.COORDINATOR, USER_ROLES.COORDINATOR_LEAD), requireVisibleEvent];
router.get("/:id/venue-availability", ...assignedCoordinatorOnly, getEventVenueAvailability);
router.get("/:id/venue-options", ...eventVenueReaders, getEventVenueOptions);
router.put("/:id/venue-suggestion", ...coordinatorOnly, requireVisibleEvent, suggestEventVenue);
// SPM-179: anyone outside the event gets "not found"; the handler refuses
// related users who are not the assigned coordinator of a PLANNING event.
router.get("/:id/venue-bookings", ...eventVenueReaders, listEventVenueBookings);
router.post("/:id/venue-bookings", anySignedInUser, requireVisibleEvent, requestVenueBookings);
// Advisory per-booking checks while the request is prepared (SPM-186); nothing is saved.
router.post("/:id/venue-bookings/check", anySignedInUser, requireVisibleEvent, checkVenueBookings);
// Tentative holds (SPM-190): the coordinator requests, Venue Staff place.
router.get("/:id/venue-holds", ...eventVenueReaders, listEventHolds);
router.post("/:id/venue-holds", anySignedInUser, requireVisibleEvent, requestVenueHold);
router.get("/:id/history", anySignedInUser, validateCursorPagination, requireVisibleEvent, getEventHistory);
router.post("/:id/history/viewed", anySignedInUser, requireVisibleEvent, markEventHistoryViewed);
// SPM-41 clarification threads: another coordinator gets 404; same-organisation
// organisers read every thread but get 403 when they write.
router.get("/:id/clarifications", anySignedInUser, requireVisibleEvent, getEventClarifications);
router.post("/:id/clarifications", assignedCoordinatorOnly, requestClarification);
router.post("/:id/clarifications/:round/messages", anySignedInUser, requireVisibleEvent, postClarificationMessage);
router.post("/:id/clarifications/:round/read", anySignedInUser, requireVisibleEvent, markClarificationRead);
router.post("/:id/clarifications/:round/complete", assignedCoordinatorOnly, completeClarification);
router.post("/:id/amendments", organiserOnly, requireVisibleEvent, saveClarificationAmendments);
// SPM-251: each role's own scope is checked in the controller, because Leads,
// Venue Staff and Technical Support have none through requireVisibleEvent.
router.get("/:id/safety-reviews", anySignedInUser, getEventSafetyReviews);
router.get("/:id/arrangements", anySignedInUser, requireVisibleEvent, getOrganiserArrangements);
router.get("/:id", anySignedInUser, requireVisibleEvent, getEventRequest);
router.put("/:id", anySignedInUser, requireVisibleEvent, updateEventDetails);
router.put("/:id/draft", organiserOnly, requireVisibleEvent, updateDraft);
router.put("/:id/submit", organiserOnly, submitDraft);

module.exports = router;
