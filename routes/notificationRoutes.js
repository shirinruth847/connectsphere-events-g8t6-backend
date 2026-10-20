const express = require("express");
const router = express.Router();

const { listNotifications, getUnreadCount, markRead, markAllRead } = require("../controller/notificationController");
const { requireAuth } = require("../middleware/auth");
const { validateCursorPagination } = require("../middleware/validate");

// Every role has an inbox. Each user reaches only their own notifications, and
// the database hides those whose event relationship has ended (SPM-155 AC6).
router.get("/", requireAuth, validateCursorPagination, listNotifications);
router.get("/unread-count", requireAuth, getUnreadCount);
router.post("/read-all", requireAuth, markAllRead); // must stay above "/:id"
router.post("/:id/read", requireAuth, markRead);

module.exports = router;
