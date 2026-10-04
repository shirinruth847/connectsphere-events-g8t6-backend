const { findOrganiserEventRequests } = require("../model/eventModel");

const listEventRequests = async (req, res) => {
  try {
    const events = await findOrganiserEventRequests(req.user);
    res.status(200).json({ events });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

module.exports = { listEventRequests };
