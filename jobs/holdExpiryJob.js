// SPM-190 (Master 5.4.3): tells the coordinator and Venue Staff when a
// tentative hold is 24 hours from expiry and when it expires, and records
// overdue holds as EXPIRED. Reads already treat an overdue hold as expired, so
// a late run changes no availability. Notifications use a unique key per hold
// and kind, so a repeated or parallel run never sends one twice.
// Same shape as eventReminderJob.js.
const venueModel = require("../model/venueModel");

const BATCH_SIZE = 100;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

const runHoldExpiry = async (now = new Date()) => venueModel.processDueHolds({ now, limit: BATCH_SIZE });

// HOLD_EXPIRY_INTERVAL_MS sets the period; 0 turns the job off.
const readIntervalMs = () => {
  const configured = process.env.HOLD_EXPIRY_INTERVAL_MS;
  if (configured === undefined || configured === "") return DEFAULT_INTERVAL_MS;
  const value = Number(configured);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_INTERVAL_MS;
};

// Returns a function that stops the job, or null when it is turned off.
const startHoldExpiryJob = (intervalMs = readIntervalMs()) => {
  if (intervalMs === 0) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { reminded, expired } = await runHoldExpiry();
      if (reminded + expired > 0) console.log(`[jobs] hold expiry: ${reminded} reminder(s), ${expired} expired`);
    } catch (error) {
      console.error("[jobs] hold expiry failed", { message: String(error.message || "").slice(0, 200) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
};

module.exports = { runHoldExpiry, startHoldExpiryJob, readIntervalMs, BATCH_SIZE, DEFAULT_INTERVAL_MS };
