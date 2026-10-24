const { findAttendeeRegistrations } = require("../model/registrationModel");
const { findRegisteredAttendeeEvent } = require("../model/eventModel");
const { EVENT_NOT_FOUND } = require("../middleware/authorize");
const { parseEventId } = require("../middleware/validate");

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

// GET /api/registrations/mine/:eventId — the event and the attendee's own place.
// "Not found" for bad IDs and for events they hold no place on alike.
const getMyRegisteredEvent = async (req, res) => {
  try {
    const eventId = parseEventId(req.params.eventId);
    const found = eventId ? await findRegisteredAttendeeEvent(eventId, req.user.user_id) : null;
    if (!found) {
      return res.status(404).json(EVENT_NOT_FOUND);
    }
    return res.status(200).json(found);
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  }
};

module.exports = { listMyRegistrations, getMyRegisteredEvent };
