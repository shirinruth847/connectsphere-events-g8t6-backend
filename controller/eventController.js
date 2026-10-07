const { findOrganiserEventRequests } = require("../model/eventModel");

const listMyEventRequests = async (req, res) => {
  try {
    const { limit, offset } = req.pagination;
    const { events, nextOffset } = await findOrganiserEventRequests(req.user, req.pagination);
    res.status(200).json({ events, page: { limit, offset, next_offset: nextOffset } });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

module.exports = { listMyEventRequests };
