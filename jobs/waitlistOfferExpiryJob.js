// SPM-163 AC7: expires place offers nobody answered in time and offers each
// freed place to the next waitlisted attendee, including places freed while
// nobody's offer expired (a raised capacity, or offers a refused direct
// registration rolled back). The timer only triggers the work. Correctness
// comes from the database (database time, the event lock and
// a recheck of each offer), so a late, repeated or parallel run never expires
// an offer twice, and accept requests refuse overdue offers even before this
// runs (Master 5.6, 8). Same shape as eventReminderJob.js.
const waitlistModel = require("../model/waitlistModel");

// Events per batch. The function returns offers expired, so a batch that
// expired fewer than this ends the run; the next run picks up the rest.
const BATCH_SIZE = 50;
const MAX_BATCHES_PER_RUN = 20;
const DEFAULT_INTERVAL_MS = 60 * 1000;

// Drains a backlog (e.g. after downtime) in bounded batches.
const runWaitlistOfferExpiry = async () => {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const expired = await waitlistModel.expireDueWaitlistOffers(BATCH_SIZE);
    total += expired;
    if (expired < BATCH_SIZE) break;
  }
  return total;
};

// WAITLIST_OFFER_EXPIRY_INTERVAL_MS sets the period; 0 turns the job off.
const readIntervalMs = () => {
  const configured = process.env.WAITLIST_OFFER_EXPIRY_INTERVAL_MS;
  if (configured === undefined || configured === "") return DEFAULT_INTERVAL_MS;
  const value = Number(configured);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_INTERVAL_MS;
};

// Returns a function that stops the job, or null when it is turned off.
const startWaitlistOfferExpiryJob = (intervalMs = readIntervalMs()) => {
  if (intervalMs === 0) return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const expired = await runWaitlistOfferExpiry();
      if (expired > 0) console.log(`[jobs] expired ${expired} waitlist offer(s)`);
    } catch (error) {
      console.error("[jobs] waitlist offer expiry failed", { message: String(error.message || "").slice(0, 200) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
};

module.exports = {
  runWaitlistOfferExpiry,
  startWaitlistOfferExpiryJob,
  readIntervalMs,
  BATCH_SIZE,
  MAX_BATCHES_PER_RUN,
  DEFAULT_INTERVAL_MS,
};
