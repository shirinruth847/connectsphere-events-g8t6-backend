// SPM-158 (SPM-155 AC7): reminds registered attendees about 24 hours before
// their event. The timer only triggers the work. Correctness comes from the
// database (database time, SKIP LOCKED claims, a unique key per reminder), so a
// late, repeated or parallel run never sends a reminder twice (Master section 8).
// Same shape as SPM-173's eventCompletionJob.js.
const notificationModel = require("../model/notificationModel");

const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 20;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

// Drains a backlog (e.g. after downtime) in bounded batches.
const runEventReminders = async () => {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const sent = await notificationModel.sendDueEventReminders(BATCH_SIZE);
    total += sent;
    if (sent < BATCH_SIZE) break;
  }
  return total;
};

// EVENT_REMINDER_INTERVAL_MS sets the period; 0 turns the job off.
const readIntervalMs = () => {
  const configured = process.env.EVENT_REMINDER_INTERVAL_MS;
  if (configured === undefined || configured === "") return DEFAULT_INTERVAL_MS;
  const value = Number(configured);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_INTERVAL_MS;
};

// Returns a function that stops the job, or null when it is turned off.
const startEventReminderJob = (intervalMs = readIntervalMs()) => {
  if (intervalMs === 0) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sent = await runEventReminders();
      if (sent > 0) console.log(`[jobs] sent ${sent} event reminder(s)`);
    } catch (error) {
      console.error("[jobs] event reminders failed", { message: String(error.message || "").slice(0, 200) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
};

module.exports = { runEventReminders, startEventReminderJob, readIntervalMs, BATCH_SIZE, MAX_BATCHES_PER_RUN, DEFAULT_INTERVAL_MS };
