// SPM-190 orchestration in venueModel.js: placement under the venue lock
// (Master 7.4), both stores or neither, the extend-once rule and the expiry
// job. PostgreSQL and MongoDB are mocked; the SQL functions are exercised by
// the integration tests.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../config/venueLockDatabase", () => ({ getVenueLockPool: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));
jest.mock("../../model/venueCalendarModel", () => ({
  findCalendarEntries: jest.fn(),
  findCalendarEntry: jest.fn(),
  findEntriesByIds: jest.fn(),
  insertHold: jest.fn(),
  changeHold: jest.fn(),
  deleteHold: jest.fn(),
  revertHold: jest.fn(),
  ownsHoldWrite: jest.fn(),
  findHoldsExpiringBy: jest.fn(),
  markHoldExpired: jest.fn(),
}));

const supabase = require("../../config/supabase");
const { getVenueLockPool } = require("../../config/venueLockDatabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueCalendarModel = require("../../model/venueCalendarModel");
const venueModel = require("../../model/venueModel");
const { runHoldExpiry } = require("../../jobs/holdExpiryJob");

const VENUE_STAFF_ID = 30;
const HALL = 7;
const HOLD_ID = "c".repeat(24);
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(Date.now() + days * DAY);

const requestRow = (overrides = {}) => ({
  hold_request_id: 3, event_id: 42, venue_id: HALL, label: "Main hall",
  start_datetime: inDays(30).toISOString(), end_datetime: new Date(inDays(30).getTime() + 2 * 3600 * 1000).toISOString(),
  status: "PENDING", calendar_hold_id: null, ...overrides,
});

// supabase-js query resolving to `result` for both lists and maybeSingle().
const chain = (result) => {
  const query = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "order", "limit"]) query[method] = jest.fn(() => query);
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  return query;
};

let statements;
const lockClient = (answers) => {
  const client = {
    on: jest.fn(),
    removeListener: jest.fn(),
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const name = /public\.(\w+)\(/.exec(sql)?.[1] || sql.split(" ")[0];
      statements.push(name);
      const answer = answers[name];
      if (answer === undefined) return { rows: [] };
      const value = typeof answer === "function" ? answer(params) : answer;
      return { rows: [{ result: value }] };
    }),
  };
  getVenueLockPool.mockReturnValue({ connect: jest.fn().mockResolvedValue(client) });
  return client;
};

const activeHold = (overrides = {}) => ({
  id: HOLD_ID, venueId: HALL, type: "HOLD", status: "ACTIVE", eventId: 42, version: 1, extendedAt: null,
  occupiedStart: inDays(20).toISOString(), occupiedEnd: inDays(20.1).toISOString(),
  holdExpiresAt: inDays(5).toISOString(), ...overrides,
});

const place = () => venueModel.placeVenueHold({ actorId: VENUE_STAFF_ID, requestId: 3, idempotencyKey: "spm190-key-0001" });

beforeEach(() => {
  jest.clearAllMocks();
  statements = [];
  supabase.from.mockImplementation(() => chain({ data: requestRow(), error: null }));
  venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([[String(HALL), { setupMinutes: 30, turnaroundMinutes: 15 }]]));
  venueCalendarModel.findCalendarEntries.mockResolvedValue([]);
  venueCalendarModel.findEntriesByIds.mockResolvedValue(new Map());
  venueCalendarModel.ownsHoldWrite.mockResolvedValue(false);
  venueCalendarModel.insertHold.mockImplementation(async (input) => {
    statements.push("insertHold");
    return { id: input.holdId, venueId: input.venueId, eventId: input.eventId, existing: false };
  });
});

describe("placeVenueHold (SPM-190 AC1–AC4)", () => {
  test("[SPM-190-AC1] should_record_in_PostgreSQL_then_write_MongoDB_before_commit", async () => {
    const row = requestRow();
    supabase.from.mockImplementation(() => chain({ data: row, error: null }));
    const client = lockClient({
      begin_venue_hold_placement: { replay: null, bookingConflicts: [] },
      record_venue_hold_placement: { holdRequestId: 3 },
    });

    await place();

    expect(statements).toEqual(["BEGIN", "SET", "begin_venue_hold_placement", "record_venue_hold_placement", "insertHold", "COMMIT"]);
    const beginArgs = client.query.mock.calls.find(([sql]) => sql.includes("begin_venue_hold_placement"))[1];
    // The occupied range includes the Hall's 30 setup and 15 turnaround minutes.
    expect(new Date(beginArgs[2]).getTime()).toBe(new Date(row.start_datetime).getTime() - 30 * 60 * 1000);
    expect(new Date(beginArgs[3]).getTime()).toBe(new Date(row.end_datetime).getTime() + 15 * 60 * 1000);
    const placed = JSON.parse(client.query.mock.calls.find(([sql]) => sql.includes("record_venue_hold_placement"))[1][2]);
    expect(placed.holdId).toMatch(/^[0-9a-f]{24}$/);
    // [SPM-190-AC2] 7 days from now, since setup is 30 days away.
    expect(Math.abs(new Date(placed.expiresAt).getTime() - inDays(7).getTime())).toBeLessThan(5000);
    expect(venueCalendarModel.insertHold).toHaveBeenCalledWith(expect.objectContaining({
      holdId: placed.holdId, venueId: HALL, eventId: 42, label: "Main hall", createdBy: VENUE_STAFF_ID,
    }));
  });

  test("[SPM-190-AC2] should_end_the_hold_24_hours_before_setup_when_that_is_sooner", async () => {
    const start = inDays(3);
    supabase.from.mockImplementation(() => chain({ data: requestRow({ start_datetime: start.toISOString(), end_datetime: inDays(3.1).toISOString() }), error: null }));
    const client = lockClient({ begin_venue_hold_placement: { replay: null, bookingConflicts: [] }, record_venue_hold_placement: { holdRequestId: 3 } });

    await place();

    const placed = JSON.parse(client.query.mock.calls.find(([sql]) => sql.includes("record_venue_hold_placement"))[1][2]);
    expect(new Date(placed.expiresAt).getTime()).toBe(start.getTime() - 30 * 60 * 1000 - DAY);
  });

  test("[SPM-190-AC3] should_refuse_a_hold_when_setup_starts_within_24_hours", async () => {
    supabase.from.mockImplementation(() => chain({ data: requestRow({ start_datetime: inDays(0.5).toISOString(), end_datetime: inDays(0.6).toISOString() }), error: null }));
    lockClient({ begin_venue_hold_placement: { replay: null, bookingConflicts: [] } });

    await expect(place()).rejects.toMatchObject({ code: "HOLD_TOO_LATE" });
    expect(statements).not.toContain("record_venue_hold_placement");
    expect(statements).toContain("ROLLBACK");
  });

  test("[SPM-190-AC4] should_refuse_an_approved_booking_overlap", async () => {
    lockClient({ begin_venue_hold_placement: { replay: null, bookingConflicts: [{ bookingId: 900 }] } });

    await expect(place()).rejects.toMatchObject({ code: "VENUE_BOOKING_CONFLICT" });
    expect(venueCalendarModel.insertHold).not.toHaveBeenCalled();
  });

  test.each([
    ["another active hold", { type: "HOLD", status: "ACTIVE", holdExpiresAt: inDays(2).toISOString(), eventId: 77 }, "VENUE_HELD"],
    ["a block", { type: "BLOCK", status: "ACTIVE", reason: "MAINTENANCE" }, "VENUE_BLOCKED"],
  ])("[SPM-190-AC4] should_refuse_%s_on_the_calendar", async (_name, entry, code) => {
    const row = requestRow();
    venueCalendarModel.findCalendarEntries.mockResolvedValue([{
      id: "d".repeat(24), venueId: HALL, occupiedStart: row.start_datetime, occupiedEnd: row.end_datetime, ...entry,
    }]);
    lockClient({ begin_venue_hold_placement: { replay: null, bookingConflicts: [] } });

    await expect(place()).rejects.toMatchObject({ code });
  });

  test("should_ignore_an_overdue_hold_still_stored_as_active", async () => {
    const row = requestRow();
    venueCalendarModel.findCalendarEntries.mockResolvedValue([{
      id: "d".repeat(24), venueId: HALL, type: "HOLD", status: "ACTIVE", eventId: 77,
      occupiedStart: row.start_datetime, occupiedEnd: row.end_datetime, holdExpiresAt: inDays(-1).toISOString(),
    }]);
    lockClient({ begin_venue_hold_placement: { replay: null, bookingConflicts: [] }, record_venue_hold_placement: { holdRequestId: 3 } });

    await place();

    expect(statements).toContain("COMMIT");
  });

  test("should_refuse_a_venue_without_setup_and_turnaround_times_before_locking", async () => {
    venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map());

    await expect(place()).rejects.toMatchObject({ code: "VENUE_BUFFERS_NOT_SET" });
    expect(getVenueLockPool).not.toHaveBeenCalled();
  });

  test("should_undo_the_MongoDB_hold_when_the_commit_is_refused", async () => {
    const client = lockClient({ begin_venue_hold_placement: { replay: null, bookingConflicts: [] }, record_venue_hold_placement: { holdRequestId: 3 } });
    const query = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql, params) => {
      if (sql === "COMMIT") throw Object.assign(new Error("serialization failure"), { code: "40001" });
      return query(sql, params);
    });

    await expect(place()).rejects.toBeDefined();
    expect(venueCalendarModel.deleteHold).toHaveBeenCalledWith(expect.objectContaining({ venueId: HALL, writeToken: expect.any(String) }));
  });

  test("[SPM-190-TC] should_replay_without_writing_again", async () => {
    lockClient({ begin_venue_hold_placement: { replay: { holdRequestId: 3 }, bookingConflicts: [] } });

    await place();

    expect(venueCalendarModel.insertHold).not.toHaveBeenCalled();
    expect(statements).not.toContain("record_venue_hold_placement");
  });

  test("should_use_the_same_hold_id_for_the_same_key", async () => {
    const ids = [];
    for (let run = 0; run < 2; run += 1) {
      const client = lockClient({ begin_venue_hold_placement: { replay: null, bookingConflicts: [] }, record_venue_hold_placement: { holdRequestId: 3 } });
      await place();
      ids.push(JSON.parse(client.query.mock.calls.find(([sql]) => sql.includes("record_venue_hold_placement"))[1][2]).holdId);
    }
    expect(ids[0]).toBe(ids[1]);
  });
});

describe("extend and release (SPM-190 AC6)", () => {
  const extend = (days = 3) => venueModel.extendVenueHold({ actorId: VENUE_STAFF_ID, holdId: HOLD_ID, days });

  beforeEach(() => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(activeHold());
    venueCalendarModel.changeHold.mockImplementation(async (input) => {
      statements.push("changeHold");
      return { ...activeHold(), version: 2, ...input };
    });
  });

  test("[SPM-190-AC6] should_extend_once_by_the_chosen_days", async () => {
    const client = lockClient({ begin_venue_hold_change: {}, record_venue_hold_change: {} });

    await extend(3);

    expect(statements).toEqual(["BEGIN", "SET", "begin_venue_hold_change", "record_venue_hold_change", "changeHold", "COMMIT"]);
    const recordArgs = client.query.mock.calls.find(([sql]) => sql.includes("record_venue_hold_change"))[1];
    expect(recordArgs[4]).toBe("EXTEND");
    expect(new Date(recordArgs[6]).getTime() - new Date(recordArgs[5]).getTime()).toBe(3 * DAY);
    expect(venueCalendarModel.changeHold).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, release: false }));
  });

  test("[SPM-190-AC6] should_refuse_a_second_extension", async () => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(activeHold({ extendedAt: inDays(-1).toISOString() }));
    lockClient({ begin_venue_hold_change: {} });

    await expect(extend()).rejects.toMatchObject({ code: "HOLD_ALREADY_EXTENDED" });
    expect(venueCalendarModel.changeHold).not.toHaveBeenCalled();
  });

  test("[SPM-190-AC6] should_refuse_an_extension_past_24_hours_before_setup", async () => {
    // Expires in 5 days, setup in 20: the cutoff is 19 days away, so 7 days still fits; 15 would not.
    venueCalendarModel.findCalendarEntry.mockResolvedValue(activeHold({ holdExpiresAt: inDays(15).toISOString() }));
    lockClient({ begin_venue_hold_change: {} });

    await expect(extend(7)).rejects.toMatchObject({ code: "HOLD_EXTENSION_TOO_LONG" });
  });

  test("[SPM-190-AC5] should_refuse_changing_an_overdue_hold", async () => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(activeHold({ holdExpiresAt: inDays(-0.1).toISOString() }));
    lockClient({ begin_venue_hold_change: {} });

    await expect(extend()).rejects.toMatchObject({ code: "HOLD_EXPIRED" });
  });

  test("should_report_a_hold_that_is_no_longer_active", async () => {
    venueCalendarModel.findCalendarEntry
      .mockResolvedValueOnce(activeHold())
      .mockResolvedValueOnce(activeHold({ status: "RELEASED" }));
    lockClient({ begin_venue_hold_change: {} });

    await expect(extend()).rejects.toMatchObject({ code: "HOLD_NOT_ACTIVE", currentStatus: "RELEASED" });
  });

  test("should_answer_HOLD_NOT_FOUND_for_a_block_id", async () => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(activeHold({ type: "BLOCK", eventId: null }));

    await expect(extend()).rejects.toMatchObject({ code: "HOLD_NOT_FOUND" });
    expect(getVenueLockPool).not.toHaveBeenCalled();
  });

  test("should_release_and_revert_MongoDB_if_the_commit_is_refused", async () => {
    const client = lockClient({ begin_venue_hold_change: {}, record_venue_hold_change: {} });
    const query = client.query.getMockImplementation();
    client.query.mockImplementation(async (sql, params) => {
      if (sql === "COMMIT") throw Object.assign(new Error("serialization failure"), { code: "40001" });
      return query(sql, params);
    });

    await expect(venueModel.releaseVenueHold({ actorId: VENUE_STAFF_ID, holdId: HOLD_ID })).rejects.toBeDefined();

    expect(venueCalendarModel.changeHold).toHaveBeenCalledWith(expect.objectContaining({ release: true }));
    expect(venueCalendarModel.revertHold).toHaveBeenCalledWith(expect.objectContaining({ holdId: HOLD_ID, version: 2 }));
  });
});

describe("hold expiry job (SPM-190 AC5)", () => {
  test("[SPM-190-AC5] should_remind_before_expiry_and_expire_overdue_holds", async () => {
    const now = new Date();
    venueCalendarModel.findHoldsExpiringBy.mockResolvedValue([
      activeHold({ id: "e".repeat(24), holdExpiresAt: new Date(now.getTime() - 1000).toISOString() }),
      activeHold({ holdExpiresAt: new Date(now.getTime() + 3600 * 1000).toISOString() }),
    ]);
    venueCalendarModel.markHoldExpired.mockResolvedValue(true);
    supabase.rpc.mockResolvedValue({ data: {}, error: null });

    const result = await runHoldExpiry(now);

    expect(result).toEqual({ checked: 2, reminded: 1, expired: 1 });
    expect(venueCalendarModel.findHoldsExpiringBy).toHaveBeenCalledWith(new Date(now.getTime() + DAY), { limit: 100 });
    expect(supabase.rpc.mock.calls.map(([, args]) => args.p_kind)).toEqual(["EXPIRED", "EXPIRING"]);
    expect(venueCalendarModel.markHoldExpired).toHaveBeenCalledWith({ holdId: "e".repeat(24), now });
  });

  test("should_not_mark_a_hold_expired_when_the_notice_failed", async () => {
    venueCalendarModel.findHoldsExpiringBy.mockResolvedValue([activeHold({ holdExpiresAt: inDays(-0.1).toISOString() })]);
    supabase.rpc.mockResolvedValue({ data: null, error: { code: "08006", message: "connection failure" } });

    await expect(runHoldExpiry()).rejects.toBeDefined();
    expect(venueCalendarModel.markHoldExpired).not.toHaveBeenCalled();
  });
});
