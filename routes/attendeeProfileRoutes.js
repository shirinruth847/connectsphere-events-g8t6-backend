const express = require("express");
const router = express.Router();

const { getMyAttendeeProfile, saveMyAttendeeProfile } = require("../controller/attendeeProfileController");
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { USER_ROLES } = require("../config/roles");

// No profile ID in the path: each attendee reaches only their own profile (SPM-270 AC8).
const attendeeOnly = [requireAuth, requireRole(USER_ROLES.ATTENDEE)];

router.get("/mine", attendeeOnly, getMyAttendeeProfile);
router.put("/mine", attendeeOnly, saveMyAttendeeProfile);

module.exports = router;
