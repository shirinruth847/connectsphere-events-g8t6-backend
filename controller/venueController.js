const venueModel = require("../model/venueModel");

const getVenueCatalogue = async (req, res, next) => {
  try {
    const catalogue = await venueModel.getVenueCatalogue();
    res.status(200).json(catalogue);
  } catch (err) {
    next(err);
  }
};

const addVenue = async (req, res) => {
  try {
    const venue = await venueModel.createVenue(req.body);
    res.status(201).json({ success: true, data: venue });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

const addRoom = async (req, res) => {
  try {
    const room = await venueModel.createRoom({
      ...req.body,
      venue_id: req.params.venueId,
    });
    res.status(201).json({ success: true, data: room });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

const updateVenue = async (req, res) => {
  try {
    const venue = await venueModel.updateVenue(req.params.venueId, req.body);
    res.status(200).json({ success: true, data: venue });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

module.exports = { getVenueCatalogue, addVenue, addRoom, updateVenue };
