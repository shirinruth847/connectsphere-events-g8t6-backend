const express = require("express");
const router = express.Router();

const {
  createAndSubmit,
  createDraft,
  updateDraft,
  submitDraft,
  listMyEventRequests,
  getEventRequest,
  listAssignedEvents,
  assignCoordinator,
  listLeadAssignments,
  listUnassignedEvents,
  getCoordinatorAvailability,
  reassignCoordinator,
  getUnassignedEvents,
  getCoordinatorAvailability,
  assignCoordinator,
} = require("../controller/eventController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

// Applied per route (not router-wide) so coordinator routes can be added here later.
const organiserOnly = [requireAuth, requireRole(USER_ROLES.ORGANISER)];
const coordinatorOperations = [
  requireAuth,
  requireRole(USER_ROLES.COORDINATOR, USER_ROLES.COORDINATOR_LEAD),
];
const coordinatorOnly = [requireAuth, requireRole(USER_ROLES.COORDINATOR)];
const leadOnly = [requireAuth, requireRole(USER_ROLES.COORDINATOR_LEAD)];

// GET / is left free for event discovery (Master section 3.4).
router.post("/", organiserOnly, createAndSubmit);
router.post("/drafts", organiserOnly, createDraft);
router.get(
  "/mine",
  organiserOnly,
  validateCursorPagination,
  listMyEventRequests,
); // must stay above "/:id"
router.get("/unassigned", coordinatorOperations, getUnassignedEvents);
router.get(
  "/coordinator-availability",
  coordinatorOperations,
  getCoordinatorAvailability,
);
router.patch("/:id/coordinator", coordinatorOperations, assignCoordinator);
router.get("/unassigned", leadOnly, listUnassignedEvents); // must stay above "/:id"
router.get("/coordinator-availability", leadOnly, getCoordinatorAvailability); // Lead-only cross-coordinator schedule
router.get("/assignments", leadOnly, listLeadAssignments); // must stay above "/:id"
router.get("/assigned", coordinatorOnly, listAssignedEvents); // must stay above "/:id"
router.post("/:id/coordinator", leadOnly, assignCoordinator);
router.patch("/:id/coordinator", leadOnly, reassignCoordinator);
router.get(
  "/:id",
  [requireAuth, requireRole(USER_ROLES.ORGANISER, USER_ROLES.COORDINATOR)],
  getEventRequest,
);
router.put("/:id/draft", organiserOnly, updateDraft);
router.put("/:id/submit", organiserOnly, submitDraft);

module.exports = router;
