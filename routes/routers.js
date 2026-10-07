const express = require("express");
const router = express.Router();

const test = require("../controller/authController");
const authRoutes = require("./authRoutes");
const eventRoutes = require("./eventRoutes");

router.get("/healthcheck", test);

router.use("/auth", authRoutes);
router.use("/events", eventRoutes);

module.exports = router;
