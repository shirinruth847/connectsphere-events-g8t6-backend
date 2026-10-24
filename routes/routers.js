const express = require("express");
const router = express.Router();

const { test } = require("../controller/authController");
const authRoutes = require("./authRoutes");
const eventRoutes = require("./eventRoutes");
const venueRoutes = require("./venueRoutes");
const registrationRoutes = require("./registrationRoutes");
const notificationRoutes = require("./notificationRoutes");
const equipmentRoutes = require("./equipmentRoutes");

router.get("/healthcheck", test);

router.use("/auth", authRoutes);
router.use("/events", eventRoutes);
router.use("/venues", venueRoutes);
router.use("/registrations", registrationRoutes);
router.use("/notifications", notificationRoutes);
router.use("/equipment", equipmentRoutes);

module.exports = router;
