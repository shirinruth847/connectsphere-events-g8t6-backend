const express = require("express");
const router = express.Router();

const test = require("../controller/authController");

router.get("/", test);

module.exports = router;
