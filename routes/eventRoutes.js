const express = require("express");
const router = express.Router();

const { listMyEventRequests } = require("../controller/eventController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validatePagination } = require("../middleware/validate");
const { USER_ROLES } = require("../config/roles");

// GET / is left free for event discovery (Master section 3.4).
router.get("/mine", requireAuth, requireRole(USER_ROLES.ORGANISER), validatePagination, listMyEventRequests);

module.exports = router;
