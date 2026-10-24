// SPM-52: applies pending outbox entries to MongoDB (Master 7.3 step 3). The
// timer only triggers the work. Correctness comes from the database: entries
// are claimed with a lease (FOR UPDATE SKIP LOCKED, database time), applied
// conditionally on pg_version, retried with backoff and marked FAILED after a
// bounded number of attempts, so a late, repeated or parallel run never
// applies an entry twice or out of order.
// Run once by hand: npm run mongo:sync
const outboxModel = require("../model/outboxModel");
const { OUTBOX } = require("../config/equipmentConstants");

// Drains a backlog (e.g. after MongoDB was down) in bounded batches.
const runMongoSync = async () => {
  let total = 0;
  for (let batch = 0; batch < OUTBOX.MAX_BATCHES_PER_RUN; batch += 1) {
    const claimed = await outboxModel.processDueEntries(OUTBOX.BATCH_SIZE);
    total += claimed;
    if (claimed < OUTBOX.BATCH_SIZE) break;
  }
  return total;
};

// MONGO_SYNC_INTERVAL_MS sets the period; 0 turns the job off.
const readIntervalMs = () => {
  const configured = process.env.MONGO_SYNC_INTERVAL_MS;
  if (configured === undefined || configured === "") return OUTBOX.DEFAULT_INTERVAL_MS;
  const value = Number(configured);
  return Number.isInteger(value) && value >= 0 ? value : OUTBOX.DEFAULT_INTERVAL_MS;
};

// Returns a function that stops the job, or null when it is turned off.
const startMongoSyncJob = (intervalMs = readIntervalMs()) => {
  if (intervalMs === 0) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const processed = await runMongoSync();
      if (processed > 0) console.log(`[jobs] processed ${processed} MongoDB outbox entr${processed === 1 ? "y" : "ies"}`);
    } catch (error) {
      console.error("[jobs] MongoDB sync failed", { message: String(error.message || "").slice(0, 200) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
};

if (require.main === module) {
  const { closeMongoDb } = require("../config/mongodb");
  runMongoSync()
    .then((processed) => console.log(`Processed ${processed} outbox entr${processed === 1 ? "y" : "ies"}.`))
    .catch((error) => {
      console.error("MongoDB sync failed:", error.message);
      process.exitCode = 1;
    })
    .finally(closeMongoDb);
}

module.exports = { runMongoSync, startMongoSyncJob, readIntervalMs };
