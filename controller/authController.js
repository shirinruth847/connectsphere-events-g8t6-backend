require("dotenv").config();
const healthCheck = require("../model/healthModel");

const test = async (req, res, next) => {
  try {
    const msg = await healthCheck(); // ✅ await the async function
    res.status(200).json({ message: msg });
  } catch (error) {
    return next(error);
  }
};

module.exports = test;
