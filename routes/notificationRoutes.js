const express = require("express");
const router = express.Router();

const { listNotifications, getUnreadCount, markRead, markAllRead } = require("../controller/notificationController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

// Attendees (SPM-155), organisers (SPM-192) and coordinators (SPM-193): the
// database shows an attendee only events they hold a place on, an organiser
// only events they own, and a coordinator only events assigned to them now,
// plus their "assignment ended" notices. Technical Support (SPM-286) see every
// notice sent to them. Other staff roles have no visibility rules yet and get
// 403. Each user reaches only their own notifications.
const inboxRoles = [
  requireAuth,
  requireRole(USER_ROLES.ATTENDEE, USER_ROLES.ORGANISER, USER_ROLES.COORDINATOR, USER_ROLES.TECH_SUPPORT),
];

router.get("/", inboxRoles, validateCursorPagination, listNotifications);
router.get("/unread-count", inboxRoles, getUnreadCount);
router.post("/read-all", inboxRoles, markAllRead); // must stay above "/:id"
router.post("/:id/read", inboxRoles, markRead);

module.exports = router;
