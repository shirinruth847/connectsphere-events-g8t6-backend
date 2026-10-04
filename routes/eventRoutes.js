const express = require("express");
const router = express.Router();

const { listEventRequests } = require("../controller/eventController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { USER_ROLES } = require("../config/roles");

router.get("/", requireAuth, requireRole(USER_ROLES.ORGANISER), listEventRequests);

module.exports = router;
