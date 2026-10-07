const express = require("express");
const router = express.Router();

const {
  createAndSubmit,
  createDraft,
  updateDraft,
  submitDraft,
  listMyEventRequests,
  getEventRequest,
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
  requireRole(USER_ROLES.COORDINATOR_LEAD),
];

// GET / is left free for event discovery (Master section 3.4).
router.post("/", organiserOnly, createAndSubmit);
router.post("/drafts", organiserOnly, createDraft);
router.get(
  "/mine",
  organiserOnly,
  validateCursorPagination,
  listMyEventRequests,
); // must stay above "/:id"
router.get(
  "/unassigned",
  coordinatorOperations,
  getUnassignedEvents,
);
router.get(
  "/coordinator-availability",
  coordinatorOperations,
  getCoordinatorAvailability,
);
router.patch(
  "/:id/coordinator",
  coordinatorOperations,
  assignCoordinator,
);
router.get("/:id", organiserOnly, getEventRequest);
router.put("/:id/draft", organiserOnly, updateDraft);
router.put("/:id/submit", organiserOnly, submitDraft);

module.exports = router;
