require("dotenv").config();
const healthCheck = require("../model/healthModel");

const test = async (req, res) => {
  try {
    const msg = await healthCheck(); // ✅ await the async function
    res.status(200).json({ message: msg });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

module.exports = test;
