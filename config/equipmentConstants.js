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

// equipment_unavailability.status: an ended record keeps ACTIVE with an earlier
// end; a record cancelled before it started is CANCELLED.
const UNAVAILABILITY_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  CANCELLED: "CANCELLED",
});

const MAX_EQUIPMENT_QUANTITY = 1000000;

// outbox_entries.state (Master 7.3).
const OUTBOX_STATE = Object.freeze({
  PENDING: "PENDING",
  APPLIED: "APPLIED",
  FAILED: "FAILED",
});

// MongoDB sync (Master 7.3): batch size, lease, attempts before FAILED and the
// delay before an entry handed back during an outage is due again.
// MAX_ATTEMPTS matches the default of the claim and fail database functions.
const OUTBOX = Object.freeze({
  BATCH_SIZE: 50,
  MAX_BATCHES_PER_RUN: 20,
  LEASE_SECONDS: 60,
  MAX_ATTEMPTS: 8,
  RETRY_SECONDS: 30,
  DEFAULT_INTERVAL_MS: 30 * 1000,
});

module.exports = {
  EQUIPMENT_STATUS,
  EQUIPMENT_STATUS_LABELS,
  DETAIL_STATUS,
  DETAILS_OUT_OF_DATE_NOTICE,
  UNAVAILABILITY_REASONS,
  UNAVAILABILITY_REASON_LABELS,
  UNAVAILABILITY_STATUS,
  MAX_EQUIPMENT_QUANTITY,
  OUTBOX_STATE,
  OUTBOX,
};
