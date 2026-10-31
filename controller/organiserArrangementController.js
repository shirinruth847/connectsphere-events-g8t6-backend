const { findOrganiserArrangements, findTechnicalArrangements } = require("../model/organiserArrangementModel");
const { EVENT_RELATIONSHIP } = require("../config/eventConstants");
const { EVENT_NOT_FOUND } = require("../middleware/authorize");

const ORGANISER_READERS = Object.freeze([EVENT_RELATIONSHIP.OWNER, EVENT_RELATIONSHIP.ORGANISATION_MEMBER]);

const getOrganiserArrangements = async (req, res, next) => {
  try {
    const { event, access } = req.visibleEvent;
    // SPM-286 AC5: the assigned coordinator gets the technical section only;
    // venues and safety stay organiser-only (SPM-199 AC9).
    const isCoordinator = access.relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR;
    if (!isCoordinator && !ORGANISER_READERS.includes(access.relationship)) {
      return res.status(404).json(EVENT_NOT_FOUND);
    }
    const arrangements = isCoordinator ? await findTechnicalArrangements(event) : await findOrganiserArrangements(event);
    res.set("Cache-Control", "no-store");
    return res.json({ arrangements });
  } catch (error) {
    if (error.code === "ARRANGEMENTS_CHANGED") {
      return res.status(409).json({ code: error.code, error: "Arrangements changed while loading. Refresh to load the latest arrangements." });
    }
    return next(error);
  }
};

module.exports = { getOrganiserArrangements };
