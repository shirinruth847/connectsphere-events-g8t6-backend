const resourceModel = require("../model/resourceModel");

const listEquipment = async (req, res) => {
  try {
    const items = await resourceModel.getEquipmentList();
    res.status(200).json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const bookVenue = async (req, res) => {
  try {
    const booking = await resourceModel.createVenueBooking(req.body);
    res.status(201).json({ success: true, data: booking });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

const requestEquipment = async (req, res) => {
  try {
    const request = await resourceModel.createEquipmentRequest(req.body);
    res.status(201).json({ success: true, data: request });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

module.exports = { listEquipment, bookVenue, requestEquipment };