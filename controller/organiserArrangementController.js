const { findOrganiserArrangements } = require("../model/organiserArrangementModel");
const { EVENT_RELATIONSHIP } = require("../config/eventConstants");
const { EVENT_NOT_FOUND } = require("../middleware/authorize");

const getOrganiserArrangements = async (req, res, next) => {
  try {
    const { event, access } = req.visibleEvent;
    if (![EVENT_RELATIONSHIP.OWNER, EVENT_RELATIONSHIP.ORGANISATION_MEMBER].includes(access.relationship)) {
      return res.status(404).json(EVENT_NOT_FOUND);
    }
    res.set("Cache-Control", "no-store");
    return res.json({ arrangements: await findOrganiserArrangements(event) });
  } catch (error) {
    if (error.code === "ARRANGEMENTS_CHANGED") {
      return res.status(409).json({ code: error.code, error: "Arrangements changed while loading. Refresh to load the latest arrangements." });
    }
    return next(error);
  }
};

module.exports = { getOrganiserArrangements };
