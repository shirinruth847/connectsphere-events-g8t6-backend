// SPM-158 reminder job: bounded batches and configuration. The database
// guarantees (claiming, deduplication, timing) are covered in
// tests/database/spm155Notifications.test.cjs.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/notificationModel", () => ({ sendDueEventReminders: jest.fn() }));

const notificationModel = require("../../model/notificationModel");
const {
  runEventReminders,
  startEventReminderJob,
  readIntervalMs,
  BATCH_SIZE,
  MAX_BATCHES_PER_RUN,
  DEFAULT_INTERVAL_MS,
} = require("../../jobs/eventReminderJob");

const originalInterval = process.env.EVENT_REMINDER_INTERVAL_MS;

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  if (originalInterval === undefined) delete process.env.EVENT_REMINDER_INTERVAL_MS;
  else process.env.EVENT_REMINDER_INTERVAL_MS = originalInterval;
});

test("[SPM-158] drains full batches and stops at the first partial one", async () => {
  notificationModel.sendDueEventReminders
    .mockResolvedValueOnce(BATCH_SIZE)
    .mockResolvedValueOnce(BATCH_SIZE)
    .mockResolvedValueOnce(7);
  expect(await runEventReminders()).toBe(BATCH_SIZE * 2 + 7);
  expect(notificationModel.sendDueEventReminders).toHaveBeenCalledTimes(3);
  expect(notificationModel.sendDueEventReminders).toHaveBeenCalledWith(BATCH_SIZE);
});

test("[SPM-158] never runs more than the batch cap in one run", async () => {
  notificationModel.sendDueEventReminders.mockResolvedValue(BATCH_SIZE);
  expect(await runEventReminders()).toBe(BATCH_SIZE * MAX_BATCHES_PER_RUN);
  expect(notificationModel.sendDueEventReminders).toHaveBeenCalledTimes(MAX_BATCHES_PER_RUN);
});

test.each([
  [undefined, DEFAULT_INTERVAL_MS],
  ["", DEFAULT_INTERVAL_MS],
  ["0", 0],
  ["60000", 60000],
  ["-5", DEFAULT_INTERVAL_MS],
  ["soon", DEFAULT_INTERVAL_MS],
])("[SPM-158] EVENT_REMINDER_INTERVAL_MS=%s gives %s", (configured, expected) => {
  if (configured === undefined) delete process.env.EVENT_REMINDER_INTERVAL_MS;
  else process.env.EVENT_REMINDER_INTERVAL_MS = configured;
  expect(readIntervalMs()).toBe(expected);
});

test("[SPM-158] an interval of 0 turns the job off", () => {
  expect(startEventReminderJob(0)).toBeNull();
  expect(notificationModel.sendDueEventReminders).not.toHaveBeenCalled();
});

test("[SPM-158] runs once at start, logs failures without crashing, and stops", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  notificationModel.sendDueEventReminders.mockRejectedValue(new Error("[Supabase Error] down"));
  const stop = startEventReminderJob(60000);
  await new Promise((resolve) => setImmediate(resolve));
  expect(notificationModel.sendDueEventReminders).toHaveBeenCalledTimes(1);
  expect(console.error).toHaveBeenCalledWith("[jobs] event reminders failed", { message: "[Supabase Error] down" });
  stop();
});
