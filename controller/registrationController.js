const { findAttendeeRegistrations } = require("../model/registrationModel");

const listMyRegistrations = async (req, res) => {
  try {
    const registrations = await findAttendeeRegistrations(req.user.user_id);
    res.status(200).json({ registrations });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

module.exports = { listMyRegistrations };
