const express = require("express");
const router = express.Router();

const { listMyRegistrations, getMyRegisteredEvent, registerForMyEvent } = require("../controller/registrationController");
const { joinMyWaitlist, leaveMyWaitlist, acceptMyOffer, declineMyOffer } = require("../controller/waitlistController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validatePagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

const attendeeOnly = [requireAuth, requireRole(USER_ROLES.ATTENDEE)];

router.get("/mine", attendeeOnly, validatePagination, listMyRegistrations);
// An event the attendee holds a place on, in any status (SPM-155 AC4, AC5).
// Event Discovery keeps its own rules at GET /api/events/discovery/:id.
router.get("/mine/:eventId", attendeeOnly, getMyRegisteredEvent);
// Direct registration (SPM-134); a full event is refused, never waitlisted here.
router.post("/mine/:eventId", attendeeOnly, registerForMyEvent);
// Waitlist and place offers (SPM-163); the attendee always comes from the session.
router.post("/mine/:eventId/waitlist", attendeeOnly, joinMyWaitlist);
router.post("/mine/:eventId/waitlist/leave", attendeeOnly, leaveMyWaitlist);
router.post("/mine/:eventId/offer/accept", attendeeOnly, acceptMyOffer);
router.post("/mine/:eventId/offer/decline", attendeeOnly, declineMyOffer);

module.exports = router;
