const express = require("express");
const router = express.Router();

const test= require("../controller/authController");

router.get("/healthcheck", test)

module.exports = router;