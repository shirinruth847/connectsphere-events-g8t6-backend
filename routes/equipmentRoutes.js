const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/authorize");
const { validatePagination } = require("../middleware/validate");
const {
  listEquipment,
  listEquipmentOptions,
  getEquipment,
  createEquipment,
  updateEquipment,
  changeEquipmentStatus,
  recordUnavailability,
  updateUnavailability,
  endUnavailability,
  listTechnicalRequests,
  getTechnicalRequest,
  decideTechnicalRequest,
} = require("../controller/equipmentController");

// Equipment catalogue (SPM-52): Technical Support only, reads included.
const techSupportOnly = [requireAuth, requireRole("TECH_SUPPORT")];

router.get("/", ...techSupportOnly, validatePagination, listEquipment);
// Categories for the filter; declared before /:equipmentId.
router.get("/options", ...techSupportOnly, listEquipmentOptions);
// Technical request dashboard (SPM-287); declared before /:equipmentId.
router.get("/requests", ...techSupportOnly, validatePagination, listTechnicalRequests);
router.get("/requests/:requestId", ...techSupportOnly, getTechnicalRequest);
router.post("/requests/:requestId/decision", ...techSupportOnly, decideTechnicalRequest);
router.get("/:equipmentId", ...techSupportOnly, getEquipment);
router.post("/", ...techSupportOnly, createEquipment);
router.put("/:equipmentId", ...techSupportOnly, updateEquipment);
router.put("/:equipmentId/status", ...techSupportOnly, changeEquipmentStatus);

// Unavailable stock (SPM-52 AC8, Master 5.5).
router.post("/:equipmentId/unavailability", ...techSupportOnly, recordUnavailability);
router.put("/:equipmentId/unavailability/:unavailabilityId", ...techSupportOnly, updateUnavailability);
router.post("/:equipmentId/unavailability/:unavailabilityId/end", ...techSupportOnly, endUnavailability);

module.exports = router;
