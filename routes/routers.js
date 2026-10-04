const express = require("express");
const router = express.Router();

const { test } = require("../controller/authController");
const authRoutes = require("./authRoutes");
const eventRoutes = require("./eventRoutes");
// const venueRoutes = require("./venueRoutes");
// const resourceRoutes = require("./resourceRoutes");
const registrationRoutes = require("./registrationRoutes");

router.get("/healthcheck", test);

router.use("/auth", authRoutes);
router.use("/events", eventRoutes);
// router.use("/venues", venueRoutes);
// router.use("/resources", resourceRoutes);
router.use("/registrations", registrationRoutes);

module.exports = router;
