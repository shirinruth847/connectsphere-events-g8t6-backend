// SPM-163 offer expiry job: bounded batches and configuration. The database
// guarantees (event lock, recheck, cascade, database time) are covered in
// tests/database/spm163Waitlist.test.cjs.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/waitlistModel", () => ({ expireDueWaitlistOffers: jest.fn() }));

const waitlistModel = require("../../model/waitlistModel");
const {
  runWaitlistOfferExpiry,
  startWaitlistOfferExpiryJob,
  readIntervalMs,
  BATCH_SIZE,
  MAX_BATCHES_PER_RUN,
  DEFAULT_INTERVAL_MS,
} = require("../../jobs/waitlistOfferExpiryJob");

const originalInterval = process.env.WAITLIST_OFFER_EXPIRY_INTERVAL_MS;

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  if (originalInterval === undefined) delete process.env.WAITLIST_OFFER_EXPIRY_INTERVAL_MS;
  else process.env.WAITLIST_OFFER_EXPIRY_INTERVAL_MS = originalInterval;
});

test("[SPM-163 AC7] drains full batches and stops at the first partial one", async () => {
  waitlistModel.expireDueWaitlistOffers.mockResolvedValueOnce(BATCH_SIZE).mockResolvedValueOnce(BATCH_SIZE + 3).mockResolvedValueOnce(2);
  expect(await runWaitlistOfferExpiry()).toBe(BATCH_SIZE * 2 + 5);
  expect(waitlistModel.expireDueWaitlistOffers).toHaveBeenCalledTimes(3);
  expect(waitlistModel.expireDueWaitlistOffers).toHaveBeenCalledWith(BATCH_SIZE);
});

test("[SPM-163 AC7] never runs more than the batch cap in one run", async () => {
  waitlistModel.expireDueWaitlistOffers.mockResolvedValue(BATCH_SIZE);
  expect(await runWaitlistOfferExpiry()).toBe(BATCH_SIZE * MAX_BATCHES_PER_RUN);
  expect(waitlistModel.expireDueWaitlistOffers).toHaveBeenCalledTimes(MAX_BATCHES_PER_RUN);
});

test("[SPM-163 AC7] a run with nothing due makes one call", async () => {
  waitlistModel.expireDueWaitlistOffers.mockResolvedValue(0);
  expect(await runWaitlistOfferExpiry()).toBe(0);
  expect(waitlistModel.expireDueWaitlistOffers).toHaveBeenCalledTimes(1);
});

test.each([
  [undefined, DEFAULT_INTERVAL_MS],
  ["", DEFAULT_INTERVAL_MS],
  ["0", 0],
  ["30000", 30000],
  ["-5", DEFAULT_INTERVAL_MS],
  ["1.5", DEFAULT_INTERVAL_MS],
  ["soon", DEFAULT_INTERVAL_MS],
])("[SPM-163] WAITLIST_OFFER_EXPIRY_INTERVAL_MS=%s gives %s", (configured, expected) => {
  if (configured === undefined) delete process.env.WAITLIST_OFFER_EXPIRY_INTERVAL_MS;
  else process.env.WAITLIST_OFFER_EXPIRY_INTERVAL_MS = configured;
  expect(readIntervalMs()).toBe(expected);
});

test("[SPM-163] an interval of 0 turns the job off", () => {
  expect(startWaitlistOfferExpiryJob(0)).toBeNull();
  expect(waitlistModel.expireDueWaitlistOffers).not.toHaveBeenCalled();
});

test("[SPM-163] runs once at start, logs failures without crashing, and stops", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  waitlistModel.expireDueWaitlistOffers.mockRejectedValue(new Error("[Supabase Error] down"));
  const stop = startWaitlistOfferExpiryJob(60000);
  await new Promise((resolve) => setImmediate(resolve));
  expect(waitlistModel.expireDueWaitlistOffers).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith("[jobs] waitlist offer expiry failed", { message: "[Supabase Error] down" });
  stop();
});

test("[SPM-163] a tick that is still running is not started again", async () => {
  let finish;
  waitlistModel.expireDueWaitlistOffers.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  jest.useFakeTimers();
  try {
    const stop = startWaitlistOfferExpiryJob(1000);
    jest.advanceTimersByTime(3000);
    expect(waitlistModel.expireDueWaitlistOffers).toHaveBeenCalledTimes(1);
    finish(0);
    stop();
  } finally {
    jest.useRealTimers();
  }
});
