const express = require("express");
const router = express.Router();

const { listNotifications, getUnreadCount, markRead, markAllRead } = require("../controller/notificationController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validateCursorPagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

// Attendees only for now (SPM-155): the database checks an attendee's event
// relationship before showing a notification (AC6). SPM-192/193 open the inbox
// to other roles together with their own visibility rules; until then they get 403.
// Each user reaches only their own notifications.
const attendeeOnly = [requireAuth, requireRole(USER_ROLES.ATTENDEE)];

router.get("/", attendeeOnly, validateCursorPagination, listNotifications);
router.get("/unread-count", attendeeOnly, getUnreadCount);
router.post("/read-all", attendeeOnly, markAllRead); // must stay above "/:id"
router.post("/:id/read", attendeeOnly, markRead);

module.exports = router;
