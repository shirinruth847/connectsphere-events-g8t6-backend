const express = require("express");
const router = express.Router();

const { listNotifications, getUnreadCount, markRead, markAllRead } = require("../controller/notificationController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

// Attendees (SPM-155) and organisers (SPM-192): the database shows an attendee
// only events they hold a place on, and an organiser only events they own.
// SPM-193 opens the inbox to staff with their own visibility rules; until then
// they get 403. Each user reaches only their own notifications.
const inboxRoles = [requireAuth, requireRole(USER_ROLES.ATTENDEE, USER_ROLES.ORGANISER)];

router.get("/", inboxRoles, validateCursorPagination, listNotifications);
router.get("/unread-count", inboxRoles, getUnreadCount);
router.post("/read-all", inboxRoles, markAllRead); // must stay above "/:id"
router.post("/:id/read", inboxRoles, markRead);

module.exports = router;
