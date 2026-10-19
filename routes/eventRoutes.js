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
  getEventRequest,
  getEventHistory,
  listAssignedEvents,
  assignCoordinator,
  listLeadAssignments,
  listUnassignedEvents,
  getCoordinatorAvailability,
  patchCoordinator,
  reassignCoordinator,
} = require("../controller/eventController");
const { requireAuth } = require("../middleware/auth");
const { requireRole, requireVisibleEvent } = require("../middleware/authorize");
const { validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

// Applied per route (not router-wide) so coordinator routes can be added here later.
const organiserOnly = [requireAuth, requireRole(USER_ROLES.ORGANISER)];
const coordinatorOnly = [requireAuth, requireRole(USER_ROLES.COORDINATOR)];
const leadOnly = [requireAuth, requireRole(USER_ROLES.COORDINATOR_LEAD)];
const coordinatorOperations = [
  requireAuth,
  requireRole(USER_ROLES.COORDINATOR, USER_ROLES.COORDINATOR_LEAD),
];
// No role gate on these: requireVisibleEvent answers "not found" unless the event is
// inside the user's viewing scope, rather than a role error that confirms it exists
// (SPM-33). It runs last in each chain, so earlier checks keep their precedence.
const anySignedInUser = [requireAuth];

// GET / is left free for event discovery (Master section 3.4).
router.post("/", organiserOnly, createAndSubmit);
router.post("/drafts", organiserOnly, createDraft);
router.get("/request-options", organiserOnly, getRequestOptions);
router.get("/mine", organiserOnly, validateCursorPagination, listMyEventRequests); // must stay above "/:id"
// Pending coordinator workflows are opt-in on this completed-ticket baseline.
if (process.env.ENABLE_COORDINATOR_WORKFLOWS === "true") {
  // SPM-177 lets coordinators and Leads inspect the queue and available schedules.
  router.get("/unassigned", coordinatorOperations, listUnassignedEvents); // must stay above "/:id"
  router.get("/coordinator-availability", coordinatorOperations, getCoordinatorAvailability);
  router.get("/assignments", leadOnly, listLeadAssignments); // must stay above "/:id"
  router.post("/:id/coordinator", leadOnly, assignCoordinator);
  // PATCH assigns an unassigned event for coordinators or Leads; only Leads may
  // reassign an event by including expectedCoordinatorId.
  router.patch("/:id/coordinator", coordinatorOperations, patchCoordinator);
} else {
  router.all(["/unassigned", "/coordinator-availability", "/assignments", "/:id/coordinator"], (req, res) => res.status(404).json({ error: "Not found.", code: "NOT_FOUND" }));
}
router.get("/assigned", coordinatorOnly, listAssignedEvents); // must stay above "/:id"
router.get("/:id/history", anySignedInUser, validateCursorPagination, requireVisibleEvent, getEventHistory);
router.get("/:id", anySignedInUser, requireVisibleEvent, getEventRequest);
router.put("/:id", anySignedInUser, requireVisibleEvent, updateEventDetails);
router.put("/:id/draft", organiserOnly, requireVisibleEvent, updateDraft);
router.put("/:id/submit", organiserOnly, submitDraft);

module.exports = router;
