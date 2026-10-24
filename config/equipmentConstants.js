// Equipment catalogue values shared by the validator, model and job (SPM-52).

// Catalogue status shown to Technical Support. DETAILS_PENDING means the item's
// equipment_details document has not been applied yet, so it cannot be chosen
// for an event (Master 6.5).
const EQUIPMENT_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  DETAILS_PENDING: "DETAILS_PENDING",
});

const EQUIPMENT_STATUS_LABELS = Object.freeze({
  [EQUIPMENT_STATUS.ACTIVE]: "Active",
  [EQUIPMENT_STATUS.INACTIVE]: "Inactive",
  [EQUIPMENT_STATUS.DETAILS_PENDING]: "Details pending",
});

// Where the MongoDB document stands against PostgreSQL, from the item's latest
// outbox entry. NONE: no entry (rows inserted outside the app).
const DETAIL_STATUS = Object.freeze({
  CURRENT: "CURRENT",
  PENDING: "PENDING",
  OUT_OF_DATE: "OUT_OF_DATE",
  FAILED: "FAILED",
  NONE: "NONE",
});

const DETAILS_OUT_OF_DATE_NOTICE = "Details may be out of date";

const UNAVAILABILITY_REASONS = Object.freeze(["DAMAGED", "MAINTENANCE", "OTHER"]);

const UNAVAILABILITY_REASON_LABELS = Object.freeze({
  DAMAGED: "Damaged or faulty",
  MAINTENANCE: "Maintenance",
  OTHER: "Other",
});

const MAX_EQUIPMENT_QUANTITY = 1000000;

// MongoDB sync (Master 7.3): batch size, lease and attempts before FAILED.
const OUTBOX = Object.freeze({
  BATCH_SIZE: 50,
  MAX_BATCHES_PER_RUN: 20,
  LEASE_SECONDS: 60,
  MAX_ATTEMPTS: 8,
  DEFAULT_INTERVAL_MS: 30 * 1000,
});

module.exports = {
  EQUIPMENT_STATUS,
  EQUIPMENT_STATUS_LABELS,
  DETAIL_STATUS,
  DETAILS_OUT_OF_DATE_NOTICE,
  UNAVAILABILITY_REASONS,
  UNAVAILABILITY_REASON_LABELS,
  MAX_EQUIPMENT_QUANTITY,
  OUTBOX,
};
