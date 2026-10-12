const express = require("express");
const router = express.Router();

const {
  createAndSubmit,
  createDraft,
  updateDraft,
  updateEventDetails,
  submitDraft,
  listMyEventRequests,
  getEventRequest,
  getEventHistory,
} = require("../controller/eventController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

// Applied per route (not router-wide) so coordinator routes can be added here later.
const organiserOnly = [requireAuth, requireRole(USER_ROLES.ORGANISER)];
// No role gate: the event's viewing scope decides, so a user outside it gets
// "not found" rather than a role error that confirms the event exists (SPM-33).
const anySignedInUser = [requireAuth];

// GET / is left free for event discovery (Master section 3.4).
router.post("/", organiserOnly, createAndSubmit);
router.post("/drafts", organiserOnly, createDraft);
router.get("/mine", organiserOnly, validateCursorPagination, listMyEventRequests); // must stay above "/:id"
router.get("/:id/history", anySignedInUser, validateCursorPagination, getEventHistory);
router.get("/:id", anySignedInUser, getEventRequest);
router.put("/:id", anySignedInUser, updateEventDetails);
router.put("/:id/draft", organiserOnly, updateDraft);
router.put("/:id/submit", organiserOnly, submitDraft);

module.exports = router;
