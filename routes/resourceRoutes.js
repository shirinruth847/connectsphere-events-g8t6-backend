const express = require("express");
const router = express.Router();
const { listEquipment, bookVenue, requestEquipment } = require("../controller/resourceController");

router.get("/equipment", listEquipment);
router.post("/bookings", bookVenue);
router.post("/equipment-requests", requestEquipment);

module.exports = router;