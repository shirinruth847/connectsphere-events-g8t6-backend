const notificationModel = require("../model/notificationModel");
const { parseNotificationId } = require("../middleware/validate");

const NOTIFICATION_NOT_FOUND = { error: "Notification not found.", code: "NOTIFICATION_NOT_FOUND" };

const handleError = (error, res, next) => {
  if (error.name === "NotificationError" && error.code === "INVALID_CURSOR") {
    return res.status(400).json({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: { cursor: "Invalid page cursor." },
    });
  }
  return next(error);
};

// GET /api/notifications — the signed-in user's inbox, newest first (SPM-155 AC8).
const listNotifications = async (req, res, next) => {
  try {
    const [{ notifications, nextCursor }, unreadCount] = await Promise.all([
      notificationModel.findNotifications(req.user, req.pagination),
      notificationModel.countUnreadNotifications(req.user.user_id),
    ]);
    return res.status(200).json({ notifications, nextCursor, unreadCount });
  } catch (error) {
    return handleError(error, res, next);
  }
};

// GET /api/notifications/unread-count — the navigation badge.
const getUnreadCount = async (req, res, next) => {
  try {
    const unreadCount = await notificationModel.countUnreadNotifications(req.user.user_id);
    return res.status(200).json({ unreadCount });
  } catch (error) {
    return next(error);
  }
};

// POST /api/notifications/:id/read — repeating it is harmless.
const markRead = async (req, res, next) => {
  try {
    const notificationId = parseNotificationId(req.params.id);
    const notification = notificationId
      ? await notificationModel.markNotificationRead(req.user.user_id, notificationId)
      : null;
    if (!notification) {
      return res.status(404).json(NOTIFICATION_NOT_FOUND);
    }
    const unreadCount = await notificationModel.countUnreadNotifications(req.user.user_id);
    return res.status(200).json({ notification, unreadCount });
  } catch (error) {
    return next(error);
  }
};

// POST /api/notifications/read-all
const markAllRead = async (req, res, next) => {
  try {
    const updated = await notificationModel.markAllNotificationsRead(req.user.user_id);
    const unreadCount = await notificationModel.countUnreadNotifications(req.user.user_id);
    return res.status(200).json({ updated, unreadCount });
  } catch (error) {
    return next(error);
  }
};

module.exports = { listNotifications, getUnreadCount, markRead, markAllRead };
