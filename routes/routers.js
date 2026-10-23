const express = require("express");
const router = express.Router();

const { test } = require("../controller/authController");
const authRoutes = require("./authRoutes");
const eventRoutes = require("./eventRoutes");
const venueRoutes = require("./venueRoutes");
const registrationRoutes = require("./registrationRoutes");
const safetyRoutes = require("./safetyRoutes");

router.get("/healthcheck", test);

router.use("/auth", authRoutes);
router.use("/events", eventRoutes);
router.use("/venues", venueRoutes);
router.use("/registrations", registrationRoutes);
router.use("/safety-reviews", safetyRoutes);

module.exports = router;
