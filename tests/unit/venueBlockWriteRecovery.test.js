// Real local MongoDB with the production validator. No Atlas or shared fixtures.
const { MongoMemoryServer } = require("mongodb-memory-server");
const { randomUUID } = require("node:crypto");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { applyMigrations } = require("../../mongodb/migrate");
const model = require("../../model/venueCalendarModel");

jest.setTimeout(120000);
const environment = { ...process.env };
let server;
let db;
const blockId = "a".repeat(24);
const input = () => ({ blockId, venueId: 7, reason: "MAINTENANCE", note: "Repair", createdBy: 30,
  start: "2030-03-10T05:00:00.000Z", end: "2030-03-10T07:00:00.000Z", writeToken: randomUUID() });

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  process.env.MONGODB_URI = server.getUri();
  process.env.MONGODB_DB_NAME = "spm195_recovery_unit";
  db = await getMongoDb();
  await applyMigrations(db);
});
beforeEach(async () => { await db.collection("venue_calendar").deleteMany({}); });
afterAll(async () => {
  await closeMongoDb();
  await server?.stop();
  process.env = environment;
});

test("lost insert acknowledgement can be identified and undone without exposing its token", async () => {
  const attempt = input();
  // Persistence precedes the simulated transport failure seen by the caller.
  await model.insertBlock(attempt);
  expect(await model.ownsBlockWrite(attempt)).toBe(true);
  expect(await model.findCalendarEntry(blockId)).not.toHaveProperty("writeToken");
  await model.deleteBlock(attempt);
  expect(await model.findCalendarEntry(blockId)).toBeNull();
});

test("a failed retry cannot delete an earlier attempt's block", async () => {
  const earlier = input();
  await model.insertBlock(earlier);
  const retry = input();
  expect(await model.insertBlock(retry)).toMatchObject({ existing: true });
  expect(await model.ownsBlockWrite(retry)).toBe(false);
  await model.deleteBlock(retry);
  expect(await model.ownsBlockWrite(earlier)).toBe(true);
});

test.each([false, true])("an unacknowledged change can be reverted (lift=%s)", async (lift) => {
  const original = input();
  await model.insertBlock(original);
  const change = { blockId, venueId: 7, expectedVersion: 1, start: original.start,
    end: "2030-03-10T06:00:00.000Z", lift, writeToken: randomUUID() };
  await model.updateBlock(change);
  expect(await model.ownsBlockWrite(change)).toBe(true);
  await model.revertBlock({ ...change, version: 2, start: original.start, end: original.end });
  expect(await model.findCalendarEntry(blockId)).toMatchObject({ status: "ACTIVE", version: 3,
    start: new Date(original.start), end: new Date(original.end) });
});

test("a stale undo cannot overwrite a later change", async () => {
  const original = input();
  await model.insertBlock(original);
  const first = { blockId, venueId: 7, expectedVersion: 1, start: original.start,
    end: "2030-03-10T06:30:00.000Z", writeToken: randomUUID() };
  await model.updateBlock(first);
  const later = { ...first, expectedVersion: 2, end: "2030-03-10T06:00:00.000Z", writeToken: randomUUID() };
  await model.updateBlock(later);
  await model.revertBlock({ ...first, version: 2, start: original.start, end: original.end });
  expect(await model.findCalendarEntry(blockId)).toMatchObject({ version: 3, end: new Date(later.end) });
  expect(await model.ownsBlockWrite(later)).toBe(true);
});

test("the intent is stored atomically, remains private and clears only for its token", async () => {
  const original = input();
  await model.insertBlock(original);
  const writeToken = randomUUID();
  const writeRecovery = { actorId: 30, action: "LIFTED", before: { start: original.start, end: original.end },
    after: { start: original.start, end: original.end }, eventIds: [42], writeToken };
  await model.updateBlock({ blockId, venueId: 7, expectedVersion: 1, lift: true, writeToken, writeRecovery });
  expect((await model.findCalendarEntry(blockId)).writeRecovery).toEqual(writeRecovery);
  await model.clearBlockRecovery({ blockId, venueId: 7, writeToken: randomUUID() });
  expect((await model.findCalendarEntry(blockId)).writeRecovery).toEqual(writeRecovery);
  await model.clearBlockRecovery({ blockId, venueId: 7, writeToken });
  expect((await model.findCalendarEntry(blockId)).writeRecovery).toBeNull();
});
