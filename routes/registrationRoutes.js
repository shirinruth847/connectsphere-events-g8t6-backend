const express = require("express");
const router = express.Router();

const { listMyRegistrations, getMyRegisteredEvent } = require("../controller/registrationController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validatePagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

const attendeeOnly = [requireAuth, requireRole(USER_ROLES.ATTENDEE)];

router.get("/mine", attendeeOnly, validatePagination, listMyRegistrations);
// An event the attendee holds a place on, in any status (SPM-155 AC4, AC5).
// Event Discovery keeps its own rules at GET /api/events/discovery/:id.
router.get("/mine/:eventId", attendeeOnly, getMyRegisteredEvent);

module.exports = router;
