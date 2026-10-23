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
  listAssignedEvents,
  patchCoordinator,
  assignCoordinatorAsLead,
  listLeadAssignments,
  listUnassignedEvents,
  getCoordinatorAvailability,
  getEventReadiness,
  submitForSafetyReview,
  confirmEvent,
  startPreparation,
  completeEvent,
} = require("../controller/eventController");
const { requireAuth } = require("../middleware/auth");
const { requireRole, requireVisibleEvent } = require("../middleware/authorize");
const { validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

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
// Pending coordinator workflows are opt-in on this completed-ticket baseline.
if (process.env.ENABLE_COORDINATOR_WORKFLOWS === "true") {
  router.get("/unassigned", leadOnly, listUnassignedEvents); // must stay above "/:id"
  router.get("/coordinator-availability", leadOnly, getCoordinatorAvailability); // Lead-only cross-coordinator schedule
  router.get("/assignments", leadOnly, listLeadAssignments); // must stay above "/:id"
  router.post("/:id/coordinator", leadOnly, assignCoordinatorAsLead);
  router.patch("/:id/coordinator", leadOnly, patchCoordinator);
} else {
  router.all(["/unassigned", "/coordinator-availability", "/assignments", "/:id/coordinator"], (req, res) => res.status(404).json({ error: "Not found.", code: "NOT_FOUND" }));
}
router.get("/assigned", coordinatorOnly, listAssignedEvents); // must stay above "/:id"
router.get("/:id/readiness", assignedCoordinatorOnly, getEventReadiness);
router.post("/:id/submit-for-safety-review", assignedCoordinatorOnly, submitForSafetyReview);
router.post("/:id/confirm", assignedCoordinatorOnly, confirmEvent);
router.post("/:id/start-preparation", assignedCoordinatorOnly, startPreparation);
router.post("/:id/complete", assignedCoordinatorOnly, completeEvent);
router.get("/:id/history", anySignedInUser, validateCursorPagination, requireVisibleEvent, getEventHistory);
router.get("/:id", anySignedInUser, requireVisibleEvent, getEventRequest);
router.put("/:id", anySignedInUser, requireVisibleEvent, updateEventDetails);
router.put("/:id/draft", organiserOnly, requireVisibleEvent, updateDraft);
router.put("/:id/submit", organiserOnly, submitDraft);

module.exports = router;
