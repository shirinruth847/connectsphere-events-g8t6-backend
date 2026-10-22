// SPM-173 AC12: completes CONFIRMED and PREPARATION events whose end has passed.
// The timer only triggers the work. Correctness comes from the database
// (database time, row locks with SKIP LOCKED), so a late, repeated or parallel
// run never completes an event twice or before it ends (Master section 8).
const eventModel = require("../model/eventModel");

const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 20;
const DEFAULT_INTERVAL_MS = 60 * 1000;

// Drains a backlog (e.g. after downtime) in bounded batches.
const runEventCompletion = async () => {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const completed = await eventModel.completeDueEvents(BATCH_SIZE);
    total += completed;
    if (completed < BATCH_SIZE) break;
  }
  return total;
};

// EVENT_COMPLETION_INTERVAL_MS sets the period; 0 turns the job off.
const readIntervalMs = () => {
  const configured = process.env.EVENT_COMPLETION_INTERVAL_MS;
  if (configured === undefined || configured === "") return DEFAULT_INTERVAL_MS;
  const value = Number(configured);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_INTERVAL_MS;
};

// Returns a function that stops the job, or null when it is turned off.
const startEventCompletionJob = (intervalMs = readIntervalMs()) => {
  if (intervalMs === 0) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const completed = await runEventCompletion();
      if (completed > 0) console.log(`[jobs] completed ${completed} ended event(s)`);
    } catch (error) {
      console.error("[jobs] event completion failed", { message: String(error.message || "").slice(0, 200) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
};

module.exports = { runEventCompletion, startEventCompletionJob, readIntervalMs, BATCH_SIZE, MAX_BATCHES_PER_RUN };
