const express = require("express");
const router = express.Router();

const { listMyRegistrations } = require("../controller/registrationController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { USER_ROLES } = require("../config/roles");

router.get("/mine", requireAuth, requireRole(USER_ROLES.ATTENDEE), listMyRegistrations);

module.exports = router;
