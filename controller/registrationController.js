const { findAttendeeRegistrations } = require("../model/registrationModel");

const listMyRegistrations = async (req, res) => {
  try {
    const { limit, offset } = req.pagination;
    const { registrations, nextOffset } = await findAttendeeRegistrations(req.user.user_id, req.pagination);
    res.status(200).json({ registrations, page: { limit, offset, next_offset: nextOffset } });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

module.exports = { listMyRegistrations };
