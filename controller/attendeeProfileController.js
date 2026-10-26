const { findAttendeeProfile, saveAttendeeProfile } = require("../model/attendeeProfileModel");
const { validateProfileSave } = require("../validators/attendeeProfileValidator");

const FORBIDDEN = { error: "You do not have permission to access this resource.", code: "FORBIDDEN" };
const STALE_PROFILE = {
  error: "Your profile was changed since you opened it. Reload it to see the latest details, then save again.",
  code: "STALE_PROFILE",
};

// Domain failures carry a stable code; anything else is an unexpected failure
// and is never reported as a saved profile.
const sendProfileError = (res, error) => {
  if (error.name === "AttendeeProfileError") {
    if (error.code === "NOT_ATTENDEE") return res.status(403).json(FORBIDDEN);
    if (error.code === "STALE_PROFILE") return res.status(409).json(STALE_PROFILE);
  }
  console.error("Error:", error);
  return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
};

// GET /api/attendee-profile/mine — always the signed-in attendee's own profile.
const getMyAttendeeProfile = async (req, res) => {
  try {
    const profile = await findAttendeeProfile(req.user.user_id);
    return res.status(200).json({ profile });
  } catch (error) {
    return sendProfileError(res, error);
  }
};

// PUT /api/attendee-profile/mine — 201 on the first save, 200 afterwards.
const saveMyAttendeeProfile = async (req, res) => {
  try {
    const { profile: input, fields } = validateProfileSave(req.body);
    if (fields) {
      return res.status(400).json({ error: "Please correct the highlighted fields.", code: "VALIDATION_FAILED", fields });
    }
    const { profile, created } = await saveAttendeeProfile(req.user.user_id, input);
    return res.status(created ? 201 : 200).json({ profile });
  } catch (error) {
    return sendProfileError(res, error);
  }
};

module.exports = { getMyAttendeeProfile, saveMyAttendeeProfile };
