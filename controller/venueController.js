const venueModel = require("../model/venueModel");

const getVenueCatalogue = async (req, res, next) => {
  try {
    const catalogue = await venueModel.getVenueCatalogue();
    res.status(200).json(catalogue);
  } catch (err) {
    next(err);
  }
};

module.exports = { getVenueCatalogue };
