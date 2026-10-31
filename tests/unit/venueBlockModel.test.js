// SPM-195 orchestration in venueModel.js: lock order and restarts (Master 7),
// both stores or neither (Master 7.4, AC11), replays (AC13), shorten/lift
// (AC9) and restoration (AC10). PostgreSQL and MongoDB are mocked; the SQL
// functions are covered by tests/database/spm195VenueBlocks.test.cjs.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../config/venueLockDatabase", () => ({ getVenueLockPool: jest.fn() }));
jest.mock("../../model/venueDetailModel", () => ({ getVenueDetailsByIds: jest.fn() }));
jest.mock("../../model/venueCalendarModel", () => ({
  findCalendarEntries: jest.fn(),
  findEventHolds: jest.fn(),
  findCalendarEntry: jest.fn(),
  findVenueBlocks: jest.fn(),
  findEntriesByIds: jest.fn(),
  clearBlockRecovery: jest.fn(),
  ownsBlockWrite: jest.fn(),
  insertBlock: jest.fn(),
  updateBlock: jest.fn(),
  deleteBlock: jest.fn(),
  revertBlock: jest.fn(),
}));

const supabase = require("../../config/supabase");
const { getVenueLockPool } = require("../../config/venueLockDatabase");
const venueDetailModel = require("../../model/venueDetailModel");
const venueCalendarModel = require("../../model/venueCalendarModel");
const venueModel = require("../../model/venueModel");

const VENUE_STAFF_ID = 30;
const HALL = 7;
const BLOCK = {
  reason: "MAINTENANCE",
  start: "2030-03-10T05:00:00.000Z",
  end: "2030-03-10T07:00:00.000Z",
  note: "Air conditioning repair",
};
const BLOCK_ID = "b".repeat(24);
const HOLD_ID = "c".repeat(24);

// A chainable supabase-js query resolving to `result`.
const chain = (result) => {
  const query = { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "lt", "gt", "order", "limit"]) query[method] = jest.fn(() => query);
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  return query;
};
const tables = (rowsByTable) => {
  supabase.from.mockImplementation((table) => chain({ data: rowsByTable[table] ?? [], error: null }));
};

// One client of the venue lock pool. `answers` maps a function name to the
// value (or a function returning it, or throwing) of its jsonb result.
let statements;
const lockClient = (answers) => {
  const client = {
    on: jest.fn(),
    removeListener: jest.fn(),
    release: jest.fn(),
    query: jest.fn(async (sql) => {
      const name = /public\.(\w+)\(/.exec(sql)?.[1] || sql.split(" ")[0];
      statements.push(name);
      const answer = answers[name];
      if (answer === undefined) return { rows: [] };
      const value = typeof answer === "function" ? answer(client.query.mock.calls.at(-1)[1]) : answer;
      return { rows: [{ result: value }] };
    }),
  };
  getVenueLockPool.mockReturnValue({ connect: jest.fn().mockResolvedValue(client) });
  return client;
};

const hold = (overrides = {}) => ({
  id: HOLD_ID, venueId: HALL, type: "HOLD", status: "ACTIVE", eventId: 55,
  start: "2030-03-10T05:30:00.000Z", end: "2030-03-10T06:30:00.000Z",
  occupiedStart: "2030-03-10T05:30:00.000Z", occupiedEnd: "2030-03-10T06:30:00.000Z",
  holdExpiresAt: "2030-03-01T00:00:00.000Z", ...overrides,
});
const blockEntry = (overrides = {}) => ({
  id: BLOCK_ID, venueId: HALL, type: "BLOCK", status: "ACTIVE", eventId: null,
  start: BLOCK.start, end: BLOCK.end, occupiedStart: BLOCK.start, occupiedEnd: BLOCK.end,
  reason: "MAINTENANCE", note: BLOCK.note, version: 1, ...overrides,
});
const recorded = (overrides = {}) => ({
  block: { blockId: BLOCK_ID, venueId: HALL, reason: "MAINTENANCE", start: BLOCK.start, end: BLOCK.end, note: BLOCK.note, status: "ACTIVE" },
  incidents: [{ incidentId: 1, eventId: 42, bookingId: 900, calendarHoldId: null }],
  affectedEvents: [{ eventId: 42, requestId: "REQ-000042" }],
  replayed: false,
  ...overrides,
});
const create = () => venueModel.createVenueBlock({
  actorId: VENUE_STAFF_ID, venueId: HALL, block: BLOCK, idempotencyKey: "spm195-key-0001",
});

beforeEach(() => {
  jest.clearAllMocks();
  statements = [];
  venueDetailModel.getVenueDetailsByIds.mockResolvedValue(new Map([[String(HALL), { setupMinutes: 30, turnaroundMinutes: 0 }]]));
  venueCalendarModel.clearBlockRecovery.mockResolvedValue(undefined);
  venueCalendarModel.ownsBlockWrite.mockResolvedValue(false);
  venueCalendarModel.deleteBlock.mockResolvedValue(undefined);
  venueCalendarModel.revertBlock.mockResolvedValue(undefined);
  venueCalendarModel.findCalendarEntries.mockResolvedValue([]);
  venueCalendarModel.findEntriesByIds.mockResolvedValue(new Map());
  venueCalendarModel.insertBlock.mockImplementation(async (input) => ({ ...blockEntry(), ...input, existing: false }));
  tables({ venue_booking: [{ event_id: 42 }], resource_incidents: [] });
});

describe("createVenueBlock (SPM-195)", () => {
  test("[SPM-195-AC12] should_lock_events_then_the_venue_and_write_MongoDB_last_before_commit", async () => {
    venueCalendarModel.findCalendarEntries.mockResolvedValue([hold()]);
    const client = lockClient({
      begin_venue_block: { replay: null, venue: { venueId: HALL }, affectedEventIds: [42] },
      record_venue_block: recorded(),
    });
    venueCalendarModel.insertBlock.mockImplementation(async (input) => {
      statements.push("insertBlock");
      return { ...blockEntry(), ...input, existing: false };
    });

    const result = await create();

    expect(statements).toEqual(["BEGIN", "SET", "begin_venue_block", "record_venue_block", "insertBlock", "COMMIT"]);
    const beginArgs = client.query.mock.calls.find(([sql]) => sql.includes("begin_venue_block"))[1];
    // Bookings near the block and the active hold's event, ascending.
    expect(beginArgs[6]).toEqual([42, 55]);
    expect(beginArgs.slice(4, 6)).toEqual([30, 0]);
    const recordArgs = client.query.mock.calls.find(([sql]) => sql.includes("record_venue_block"))[1];
    expect(JSON.parse(recordArgs[3])).toEqual([{ holdId: HOLD_ID, eventId: 55 }]);
    expect(JSON.parse(recordArgs[2])).toEqual({ blockId: expect.stringMatching(/^[0-9a-f]{24}$/), ...BLOCK });
    expect(venueCalendarModel.insertBlock).toHaveBeenCalledWith(expect.objectContaining({
      venueId: HALL, reason: "MAINTENANCE", start: BLOCK.start, end: BLOCK.end, createdBy: VENUE_STAFF_ID,
    }));
    expect(result.block).toEqual(expect.objectContaining({ reasonLabel: "Maintenance", statusLabel: "Active", version: 1 }));
    expect(result.incidents[0].requestId).toBe("REQ-000042");
    expect(client.release).toHaveBeenCalledWith(false);
  });

  test("[SPM-195-AC13] should_derive_the_same_block_id_for_the_same_key", async () => {
    const ids = [];
    for (let run = 0; run < 2; run += 1) {
      const client = lockClient({ begin_venue_block: { replay: null, affectedEventIds: [] }, record_venue_block: recorded() });
      await create();
      ids.push(JSON.parse(client.query.mock.calls.find(([sql]) => sql.includes("record_venue_block"))[1][2]).blockId);
    }
    expect(ids[0]).toBe(ids[1]);
  });

  test("[SPM-195-AC12] should_restart_with_the_larger_set_when_an_affected_event_was_not_locked", async () => {
    let attempt = 0;
    const client = lockClient({
      begin_venue_block: () => {
        attempt += 1;
        return { replay: null, affectedEventIds: [42, 43] };
      },
      record_venue_block: recorded(),
    });

    await create();

    expect(attempt).toBe(2);
    const lockedSets = client.query.mock.calls.filter(([sql]) => sql.includes("begin_venue_block")).map(([, args]) => args[6]);
    expect(lockedSets).toEqual([[42], [42, 43]]);
    expect(statements.filter((name) => name === "ROLLBACK")).toHaveLength(1);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  test("should_give_up_after_bounded_restarts_with_a_retryable_conflict", async () => {
    let next = 100;
    lockClient({ begin_venue_block: () => ({ replay: null, affectedEventIds: [(next += 1)] }) });
    await expect(create()).rejects.toMatchObject({ code: "VENUE_LOCK_TIMEOUT" });
    expect(statements.filter((name) => name === "begin_venue_block")).toHaveLength(3);
    expect(statements).not.toContain("COMMIT");
  });

  test("[SPM-195-TC-14] should_refuse_before_any_lock_when_MongoDB_is_unavailable", async () => {
    venueDetailModel.getVenueDetailsByIds.mockRejectedValue(Object.assign(new Error("down"), { name: "MongoServerSelectionError" }));
    lockClient({});
    await expect(create()).rejects.toMatchObject({ code: "VENUE_CALENDAR_UNAVAILABLE" });
    expect(getVenueLockPool).not.toHaveBeenCalled();
  });

  test("[SPM-195-AC11] should_roll_back_PostgreSQL_when_the_MongoDB_write_fails", async () => {
    lockClient({ begin_venue_block: { replay: null, affectedEventIds: [42] }, record_venue_block: recorded() });
    venueCalendarModel.insertBlock.mockRejectedValue(Object.assign(new Error("write failed"), { code: 91 }));
    await expect(create()).rejects.toMatchObject({ code: "VENUE_CALENDAR_UNAVAILABLE" });
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  test("[SPM-195-AC11] should_remove_its_MongoDB_block_when_the_server_refuses_the_COMMIT", async () => {
    lockClient({
      begin_venue_block: { replay: null, affectedEventIds: [42] },
      record_venue_block: recorded(),
      COMMIT: () => { throw Object.assign(new Error("could not serialize"), { code: "40001" }); },
    });
    await expect(create()).rejects.toMatchObject({ code: "VENUE_LOCK_TIMEOUT" });
    expect(venueCalendarModel.deleteBlock).toHaveBeenCalledWith({ blockId: expect.stringMatching(/^[0-9a-f]{24}$/), venueId: HALL, writeToken: expect.any(String) });
  });

  test("[SPM-195-AC11] should_keep_the_MongoDB_block_when_the_COMMIT_outcome_is_unknown", async () => {
    lockClient({
      begin_venue_block: { replay: null, affectedEventIds: [42] },
      record_venue_block: recorded(),
      COMMIT: () => { throw Object.assign(new Error("Connection terminated unexpectedly"), {}); },
    });
    await expect(create()).rejects.toThrow("Connection terminated unexpectedly");
    expect(venueCalendarModel.deleteBlock).not.toHaveBeenCalled();
  });

  test("[SPM-195-AC13] should_guard_compensation_against_a_document_written_by_an_earlier_attempt", async () => {
    lockClient({
      begin_venue_block: { replay: null, affectedEventIds: [42] },
      record_venue_block: recorded(),
      COMMIT: () => { throw Object.assign(new Error("could not serialize"), { code: "40001" }); },
    });
    venueCalendarModel.insertBlock.mockResolvedValue({ ...blockEntry(), existing: true });
    await expect(create()).rejects.toMatchObject({ code: "VENUE_LOCK_TIMEOUT" });
    expect(venueCalendarModel.deleteBlock).toHaveBeenCalledWith(expect.objectContaining({ writeToken: expect.any(String) }));
  });

  test("[SPM-195-TC-15] should_not_write_MongoDB_when_the_PostgreSQL_part_fails", async () => {
    lockClient({
      begin_venue_block: { replay: null, affectedEventIds: [42] },
      record_venue_block: () => { throw Object.assign(new Error("activity insert failed"), { code: "23514" }); },
    });
    await expect(create()).rejects.toMatchObject({ code: "23514" });
    expect(venueCalendarModel.insertBlock).not.toHaveBeenCalled();
    expect(statements).toContain("ROLLBACK");
  });

  test("[SPM-195-TC-17] should_return_a_replay_without_writing_again", async () => {
    lockClient({ begin_venue_block: { replay: recorded({ replayed: true }) } });
    const result = await create();
    expect(result.replayed).toBe(true);
    expect(statements).not.toContain("record_venue_block");
    expect(venueCalendarModel.insertBlock).not.toHaveBeenCalled();
  });

  test("[SPM-195-AC13] should_accept_its_own_earlier_MongoDB_document_but_refuse_a_different_one", async () => {
    lockClient({ begin_venue_block: { replay: null, affectedEventIds: [42] }, record_venue_block: recorded() });
    venueCalendarModel.insertBlock.mockResolvedValue({ ...blockEntry(), existing: true });
    await expect(create()).resolves.toBeDefined();

    statements = [];
    lockClient({ begin_venue_block: { replay: null, affectedEventIds: [42] }, record_venue_block: recorded() });
    venueCalendarModel.insertBlock.mockResolvedValue({ ...blockEntry({ note: "Something else" }), existing: true });
    await expect(create()).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(statements).not.toContain("COMMIT");
  });

  test("[SPM-195-AC3] should_ignore_expired_holds_and_holds_at_other_venues", async () => {
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      hold({ id: "d".repeat(24), holdExpiresAt: "2020-01-01T00:00:00.000Z" }),
      hold({ id: "e".repeat(24), venueId: 8 }),
      hold({ id: "f".repeat(24), occupiedStart: BLOCK.end, occupiedEnd: "2030-03-10T08:00:00.000Z" }),
    ]);
    const client = lockClient({ begin_venue_block: { replay: null, affectedEventIds: [42] }, record_venue_block: recorded() });
    await create();
    const recordArgs = client.query.mock.calls.find(([sql]) => sql.includes("record_venue_block"))[1];
    expect(JSON.parse(recordArgs[3])).toEqual([]);
  });

  test("should_map_a_lock_timeout_to_a_retryable_conflict", async () => {
    lockClient({ begin_venue_block: () => { throw Object.assign(new Error("lock timeout"), { code: "55P03" }); } });
    await expect(create()).rejects.toMatchObject({ code: "VENUE_LOCK_TIMEOUT" });
  });

  test("[SPM-195-AC1] should_map_the_database_role_check", async () => {
    lockClient({ begin_venue_block: () => { throw Object.assign(new Error("FORBIDDEN"), { code: "P0001" }); } });
    await expect(create()).rejects.toMatchObject({ name: "VenueError", code: "FORBIDDEN" });
  });

  test.each([
    ["40P01", "VENUE_LOCK_TIMEOUT"],
    ["40001", "VENUE_LOCK_TIMEOUT"],
    ["57014", "VENUE_BOOKINGS_UNAVAILABLE"],
    ["57P01", "VENUE_BOOKINGS_UNAVAILABLE"],
    ["08006", "VENUE_BOOKINGS_UNAVAILABLE"],
  ])("should_map_database_failure_%s", async (code, expected) => {
    lockClient({ begin_venue_block: () => { throw Object.assign(new Error("failed"), { code }); } });
    await expect(create()).rejects.toMatchObject({ name: "VenueError", code: expected });
  });

  test("should_pass_an_unknown_database_refusal_through_unchanged", async () => {
    const refusal = Object.assign(new Error("SOMETHING_ELSE"), { code: "P0001" });
    lockClient({ begin_venue_block: () => { throw refusal; } });
    await expect(create()).rejects.toBe(refusal);
  });

  test("should_label_an_unknown_reason_with_its_code", async () => {
    lockClient({
      begin_venue_block: { replay: null, affectedEventIds: [42] },
      record_venue_block: recorded({ block: { ...recorded().block, reason: "FLOOD" } }),
    });
    const result = await create();
    expect(result.block).toEqual(expect.objectContaining({ reason: "FLOOD", reasonLabel: "FLOOD", statusLabel: "Active", version: 1 }));
  });
});

describe("changeVenueBlock (SPM-195 AC9)", () => {
  const shorten = (change) => venueModel.changeVenueBlock({
    actorId: VENUE_STAFF_ID, venueId: HALL, blockId: BLOCK_ID, change: { version: 1, ...change },
  });
  const lift = (version = 1) => venueModel.changeVenueBlock({
    actorId: VENUE_STAFF_ID, venueId: HALL, blockId: BLOCK_ID, lift: { version },
  });

  beforeEach(() => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(blockEntry());
    venueCalendarModel.updateBlock.mockImplementation(async (input) => {
      statements.push("updateBlock");
      return blockEntry({ status: input.lift ? "LIFTED" : "ACTIVE", start: input.start, end: input.end, version: 2 });
    });
  });

  test("[SPM-195-TC-13] should_refuse_a_longer_block_without_locking", async () => {
    lockClient({});
    await expect(shorten({ start: BLOCK.start, end: "2030-03-10T08:00:00.000Z" }))
      .rejects.toMatchObject({ code: "BLOCK_CANNOT_BE_EXTENDED" });
    await expect(shorten({ start: "2030-03-10T04:00:00.000Z", end: BLOCK.end }))
      .rejects.toMatchObject({ code: "BLOCK_CANNOT_BE_EXTENDED" });
    expect(getVenueLockPool).not.toHaveBeenCalled();
  });

  test("should_report_an_unchanged_repeat_without_writing", async () => {
    lockClient({});
    const result = await shorten({ start: BLOCK.start, end: BLOCK.end, version: 7 });
    expect(result.changed).toBe(false);
    expect(getVenueLockPool).not.toHaveBeenCalled();
  });

  test("should_refuse_a_stale_version", async () => {
    await expect(shorten({ start: BLOCK.start, end: "2030-03-10T06:00:00.000Z", version: 3 }))
      .rejects.toMatchObject({ code: "BLOCK_VERSION_CONFLICT" });
  });

  test("[SPM-195-TC-12] should_shorten_under_the_locks_and_report_restorable_bookings", async () => {
    tables({ resource_incidents: [{
      incident_id: 1, event_id: 42, booking_id: 900, calendar_hold_id: null, calendar_block_id: BLOCK_ID, status: "OPEN",
      resolution: null, created_at: "2030-01-01T00:00:00Z", resolved_at: null, event: { title: "Gala" },
      booking: { venue_id: HALL, status: "APPROVED", start_datetime: "2030-03-10T06:00:00Z", end_datetime: "2030-03-10T08:00:00Z",
        occupied_range: '["2030-03-10 06:00:00+00","2030-03-10 08:00:00+00")' },
    }] });
    const client = lockClient({
      begin_venue_block_change: { venue: { venueId: HALL }, affectedEventIds: [42] },
      record_venue_block_change_once: { openIncidents: [] },
    });
    // After the change the block ends at 06:00, where the booking starts.
    venueCalendarModel.findCalendarEntries.mockResolvedValue([blockEntry({ end: "2030-03-10T06:00:00.000Z", occupiedEnd: "2030-03-10T06:00:00.000Z" })]);

    const result = await shorten({ start: BLOCK.start, end: "2030-03-10T06:00:00.000Z" });

    expect(statements).toEqual(["BEGIN", "SET", "begin_venue_block_change", "record_venue_block_change_once", "updateBlock", "COMMIT"]);
    expect(client.query.mock.calls.find(([sql]) => sql.includes("begin_venue_block_change"))[1][3]).toEqual([42]);
    expect(result.changed).toBe(true);
    expect(result.incidents[0]).toEqual(expect.objectContaining({
      incidentId: 1, requestId: "REQ-000042", canBeRestored: true, restoreLabel: "Can be restored",
    }));
  });

  test("should_keep_a_still_overlapping_booking_open_and_not_restorable", async () => {
    tables({ resource_incidents: [{
      incident_id: 1, event_id: 42, booking_id: 900, calendar_hold_id: null, calendar_block_id: BLOCK_ID, status: "OPEN",
      resolution: null, created_at: "2030-01-01T00:00:00Z", resolved_at: null, event: { title: "Gala" },
      booking: { venue_id: HALL, status: "APPROVED", start_datetime: "2030-03-10T06:00:00Z", end_datetime: "2030-03-10T08:00:00Z",
        occupied_range: '["2030-03-10 06:00:00+00","2030-03-10 08:00:00+00")' },
    }] });
    lockClient({ begin_venue_block_change: { affectedEventIds: [42] }, record_venue_block_change_once: { openIncidents: [] } });
    venueCalendarModel.findCalendarEntries.mockResolvedValue([blockEntry({ end: "2030-03-10T06:30:00.000Z", occupiedEnd: "2030-03-10T06:30:00.000Z" })]);

    const result = await shorten({ start: BLOCK.start, end: "2030-03-10T06:30:00.000Z" });
    expect(result.incidents[0]).toEqual(expect.objectContaining({ status: "OPEN", canBeRestored: false, restoreLabel: "Venue still blocked" }));
  });

  test("should_lift_and_answer_unchanged_for_a_lifted_block", async () => {
    lockClient({ begin_venue_block_change: { affectedEventIds: [] }, record_venue_block_change_once: { openIncidents: [] } });
    const lifted = await lift();
    expect(lifted.block.status).toBe("LIFTED");
    expect(venueCalendarModel.updateBlock).toHaveBeenCalledWith(expect.objectContaining({ lift: true, expectedVersion: 1 }));

    venueCalendarModel.findCalendarEntry.mockResolvedValue(blockEntry({ status: "LIFTED", version: 2 }));
    const repeat = await lift(1);
    expect(repeat.changed).toBe(false);
  });

  test("[SPM-195-AC11] should_put_the_block_back_when_the_server_refuses_the_COMMIT", async () => {
    lockClient({
      begin_venue_block_change: { affectedEventIds: [] },
      record_venue_block_change_once: { openIncidents: [] },
      COMMIT: () => { throw Object.assign(new Error("deferred check failed"), { code: "23514" }); },
    });
    await expect(shorten({ start: BLOCK.start, end: "2030-03-10T06:00:00.000Z" })).rejects.toMatchObject({ code: "23514" });
    expect(venueCalendarModel.revertBlock).toHaveBeenCalledWith({
      blockId: BLOCK_ID, venueId: HALL, version: 2, start: BLOCK.start, end: BLOCK.end, writeToken: expect.any(String),
    });
  });

  test("should_roll_back_when_the_block_changed_under_the_lock", async () => {
    lockClient({ begin_venue_block_change: { affectedEventIds: [] }, record_venue_block_change_once: { openIncidents: [] } });
    venueCalendarModel.updateBlock.mockResolvedValue(null);
    await expect(lift()).rejects.toMatchObject({ code: "BLOCK_VERSION_CONFLICT" });
    expect(statements).toContain("ROLLBACK");
  });

  test("should_answer_not_found_for_a_block_of_another_venue", async () => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(blockEntry({ venueId: 8 }));
    await expect(lift()).rejects.toMatchObject({ code: "BLOCK_NOT_FOUND" });
  });
});

describe("restoreVenueIncident (SPM-195 AC10)", () => {
  const incidentRow = (overrides = {}) => ({
    incident_id: 5, event_id: 42, booking_id: 900, calendar_hold_id: null, calendar_block_id: BLOCK_ID, status: "OPEN",
    resolution: null, created_at: "2030-01-01T00:00:00Z", resolved_at: null, event: { title: "Gala" },
    booking: { venue_id: HALL, status: "APPROVED", start_datetime: "2030-03-10T06:00:00Z", end_datetime: "2030-03-10T08:00:00Z", occupied_range: null },
    ...overrides,
  });
  const restore = () => venueModel.restoreVenueIncident({ actorId: VENUE_STAFF_ID, incidentId: 5, idempotencyKey: "spm195-key-0002" });
  const started = (incident = {}) => ({
    replay: null,
    incident: {
      incidentId: 5, eventId: 42, bookingId: 900, calendarHoldId: null, calendarBlockId: BLOCK_ID,
      occupiedStart: "2030-03-10T05:30:00+00:00", occupiedEnd: "2030-03-10T08:00:00+00:00", start: "2030-03-10T06:00:00+00:00",
      ...incident,
    },
  });
  const restored = { incidentId: 5, eventId: 42, status: "RESOLVED", resolution: "RESTORED", arrangementVersion: 4, changed: true };

  test("[SPM-195-TC-12] should_refuse_while_a_block_still_overlaps_the_occupied_range", async () => {
    tables({ resource_incidents: [incidentRow()] });
    lockClient({ begin_venue_incident_restore: started(), restore_venue_incident: restored });
    venueCalendarModel.findCalendarEntries.mockResolvedValue([
      blockEntry({ end: "2030-03-10T05:45:00.000Z", occupiedEnd: "2030-03-10T05:45:00.000Z" }),
    ]);
    await expect(restore()).rejects.toMatchObject({ code: "INCIDENT_STILL_BLOCKED", blocks: [expect.objectContaining({ reasonLabel: "Maintenance" })] });
    expect(statements).not.toContain("restore_venue_incident");
    expect(statements).toContain("ROLLBACK");
  });

  test("[SPM-195-TC-11] should_restore_once_the_whole_range_is_free", async () => {
    tables({ resource_incidents: [incidentRow()] });
    const client = lockClient({ begin_venue_incident_restore: started(), restore_venue_incident: restored });
    venueCalendarModel.findCalendarEntries.mockResolvedValue([blockEntry({ status: "LIFTED" })]);

    const result = await restore();

    expect(statements).toEqual(["BEGIN", "SET", "begin_venue_incident_restore", "restore_venue_incident", "COMMIT"]);
    const beginArgs = client.query.mock.calls.find(([sql]) => sql.includes("begin_venue_incident_restore"))[1];
    expect(beginArgs.slice(0, 5)).toEqual([VENUE_STAFF_ID, 5, HALL, 30, 0]);
    const restoreArgs = client.query.mock.calls.find(([sql]) => sql.includes("restore_venue_incident"))[1];
    expect(restoreArgs[3]).toBe("2030-03-10T06:00:00.000Z");
    expect(result).toEqual(expect.objectContaining({ requestId: "REQ-000042", statusLabel: "Resolved", resolutionLabel: "Booking restored" }));
  });

  test("[SPM-195-TC-17] should_return_the_final_state_of_a_resolved_incident", async () => {
    tables({ resource_incidents: [incidentRow({ status: "RESOLVED", resolution: "RESTORED" })] });
    lockClient({ begin_venue_incident_restore: { replay: { ...restored, changed: false, replayed: false } } });
    const result = await restore();
    expect(result.changed).toBe(false);
    expect(statements).not.toContain("restore_venue_incident");
  });

  test("should_use_the_hold_range_and_refuse_an_expired_hold", async () => {
    tables({ resource_incidents: [incidentRow({ booking_id: null, booking: null, calendar_hold_id: HOLD_ID })] });
    venueCalendarModel.findCalendarEntry.mockResolvedValue(hold({ holdExpiresAt: "2020-01-01T00:00:00.000Z" }));
    lockClient({ begin_venue_incident_restore: started({ bookingId: null, calendarHoldId: HOLD_ID, occupiedStart: null, occupiedEnd: null, start: null }) });
    await expect(restore()).rejects.toMatchObject({ code: "INCIDENT_NOT_RESTORABLE" });
  });

  test("should_answer_not_found_for_an_unknown_incident", async () => {
    tables({ resource_incidents: [] });
    await expect(restore()).rejects.toMatchObject({ code: "INCIDENT_NOT_FOUND" });
  });
});

describe("incident cards on the booking lists (SPM-195 AC7, AC9)", () => {
  const bookingRow = {
    booking_id: 900, venue_id: HALL, label: "Main hall", status: "APPROVED", start_datetime: "2030-03-10T06:00:00+00:00",
    end_datetime: "2030-03-10T08:00:00+00:00", expected_attendance: 100, layout_type: "Theatre", required_facilities: [],
    accessibility_requirements: [], special_requirements: null, rejection_reason: null, is_primary: true,
    occupied_range: '["2030-03-10 05:30:00+00","2030-03-10 08:00:00+00")', created_at: "2030-01-01T00:00:00+00:00",
    venue: { name: "Hall" },
  };
  const incident = {
    incident_id: 1, event_id: 42, booking_id: 900, calendar_hold_id: null, calendar_block_id: BLOCK_ID, status: "OPEN",
    resolution: null, created_at: "2030-01-02T00:00:00Z", resolved_at: null, event: { title: "Gala" },
    booking: { venue_id: HALL, status: "APPROVED", start_datetime: bookingRow.start_datetime, end_datetime: bookingRow.end_datetime, occupied_range: bookingRow.occupied_range },
  };

  test("[SPM-195-AC7] should_show_the_block_and_the_coordinator_options", async () => {
    tables({ venue_booking: [bookingRow], resource_incidents: [incident] });
    venueCalendarModel.findEntriesByIds.mockResolvedValue(new Map([[BLOCK_ID, blockEntry()]]));
    venueCalendarModel.findCalendarEntries.mockResolvedValue([blockEntry()]);

    const [booking] = await venueModel.listEventVenueBookings(42);

    expect(booking.incident).toEqual(expect.objectContaining({
      status: "OPEN",
      canBeRestored: false,
      restoreLabel: "Waiting for the venue to become free.",
      block: expect.objectContaining({ reasonLabel: "Maintenance", note: BLOCK.note, start: BLOCK.start, end: BLOCK.end }),
    }));
    expect(booking.incident.actions.map((action) => [action.action, action.available])).toEqual([
      ["RESTORE", false], ["REPLACE", false], ["CANCEL", true],
    ]);
  });

  test("should_never_claim_restorable_when_MongoDB_is_unavailable", async () => {
    tables({ venue_booking: [bookingRow], resource_incidents: [incident] });
    venueCalendarModel.findEntriesByIds.mockRejectedValue(new Error("down"));

    const [booking] = await venueModel.listEventVenueBookings(42);

    expect(booking.incident).toEqual(expect.objectContaining({ block: null, canBeRestored: null, restoreLabel: "Availability not checked." }));
  });

  test("should_leave_bookings_without_incidents_unchanged", async () => {
    tables({ venue_booking: [bookingRow], resource_incidents: [] });
    const [booking] = await venueModel.listEventVenueBookings(42);
    expect(booking.incident).toBeNull();
    expect(venueCalendarModel.findEntriesByIds).not.toHaveBeenCalled();
  });

  test("should_never_offer_restore_for_a_booking_that_has_ended", async () => {
    tables({
      venue_booking: [bookingRow],
      resource_incidents: [{ ...incident, booking: { ...incident.booking, status: "REJECTED" } }],
    });
    venueCalendarModel.findEntriesByIds.mockResolvedValue(new Map([[BLOCK_ID, blockEntry({ status: "LIFTED" })]]));

    const [booking] = await venueModel.listEventVenueBookings(42);

    expect(booking.incident).toEqual(expect.objectContaining({
      canBeRestored: false, restoreLabel: "The booking or hold has ended, so it cannot be restored.",
    }));
    expect(venueCalendarModel.findCalendarEntries).not.toHaveBeenCalled();
  });
});

describe("listVenueBlocks (SPM-195 AC9)", () => {
  const holdIncident = {
    incident_id: 7, event_id: 55, booking_id: null, calendar_hold_id: HOLD_ID, calendar_block_id: BLOCK_ID, status: "OPEN",
    resolution: null, created_at: "2030-01-02T00:00:00Z", resolved_at: null, event: { title: "Expo" }, booking: null,
  };

  test("should_show_an_expired_hold_as_never_restorable_and_report_a_cut_list", async () => {
    tables({ venue: { venue_id: HALL, name: "Hall" }, resource_incidents: [holdIncident] });
    venueCalendarModel.findVenueBlocks.mockResolvedValue({ blocks: [blockEntry({ status: "LIFTED" })], hasMore: true });
    venueCalendarModel.findEntriesByIds.mockResolvedValue(new Map([
      [BLOCK_ID, blockEntry({ status: "LIFTED" })],
      [HOLD_ID, hold({ holdExpiresAt: "2020-01-01T00:00:00.000Z" })],
    ]));

    const result = await venueModel.listVenueBlocks(HALL);

    expect(result.hasMore).toBe(true);
    expect(result.blocks[0].incidents[0]).toEqual(expect.objectContaining({
      incidentId: 7, canBeRestored: false, restoreLabel: "Booking or hold has ended",
    }));
  });

  test("should_count_overlapping_bookings_of_finished_events_that_the_block_left_alone", async () => {
    tables({
      venue: { venue_id: HALL, name: "Hall" },
      resource_incidents: [],
      venue_booking: [
        // Occupied 12:30–15:30 UTC with setup and turnaround: overlaps the 13:00–15:00 block.
        { booking_id: 114, start_datetime: "2030-03-10T05:30:00Z", end_datetime: "2030-03-10T06:30:00Z", occupied_range: "[\"2030-03-10 04:30:00+00\",\"2030-03-10 07:30:00+00\")", event: { status: "COMPLETED" } },
        // Ends before the block starts.
        { booking_id: 115, start_datetime: "2030-03-10T02:00:00Z", end_datetime: "2030-03-10T03:00:00Z", occupied_range: "[\"2030-03-10 01:30:00+00\",\"2030-03-10 03:30:00+00\")", event: { status: "CANCELLED" } },
      ],
    });
    venueCalendarModel.findVenueBlocks.mockResolvedValue({ blocks: [blockEntry()], hasMore: false });
    venueCalendarModel.findEntriesByIds.mockResolvedValue(new Map());

    const result = await venueModel.listVenueBlocks(HALL);

    expect(result.blocks[0]).toMatchObject({ incidents: [], closedEventBookings: 1 });
  });
});


describe("SPM-195 acknowledgement-loss recovery", () => {
  test("commits PostgreSQL when the persisted create is confirmed by its token", async () => {
    lockClient({ begin_venue_block: { replay: null, affectedEventIds: [42] }, record_venue_block: recorded() });
    venueCalendarModel.insertBlock.mockRejectedValue(new Error("acknowledgement lost"));
    venueCalendarModel.ownsBlockWrite.mockResolvedValue(true);
    venueCalendarModel.findCalendarEntry.mockResolvedValue(blockEntry());
    await expect(create()).resolves.toMatchObject({ replayed: false });
    expect(statements).toContain("COMMIT");
    expect(venueCalendarModel.deleteBlock).not.toHaveBeenCalled();
  });

  test("registers token-guarded undo even when the create never returns", async () => {
    lockClient({ begin_venue_block: { replay: null, affectedEventIds: [42] }, record_venue_block: recorded() });
    venueCalendarModel.insertBlock.mockRejectedValue(new Error("acknowledgement lost"));
    await expect(create()).rejects.toMatchObject({ code: "VENUE_CALENDAR_UNAVAILABLE" });
    const input = venueCalendarModel.insertBlock.mock.calls[0][0];
    expect(venueCalendarModel.deleteBlock).toHaveBeenCalledWith({ blockId: input.blockId, venueId: HALL, writeToken: input.writeToken });
    expect(statements).toContain("ROLLBACK");
  });

  test.each([false, true])("recovers a persisted change (lift=%s) before PostgreSQL commit", async (lift) => {
    venueCalendarModel.findCalendarEntry.mockResolvedValue(blockEntry());
    lockClient({ begin_venue_block_change: { affectedEventIds: [] }, record_venue_block_change_once: { openIncidents: [] } });
    venueCalendarModel.updateBlock.mockImplementation(async () => {
      venueCalendarModel.findCalendarEntry.mockResolvedValue(blockEntry({ version: 2, status: lift ? "LIFTED" : "ACTIVE" }));
      throw new Error("acknowledgement lost");
    });
    venueCalendarModel.ownsBlockWrite.mockResolvedValue(true);
    const input = { actorId: VENUE_STAFF_ID, venueId: HALL, blockId: BLOCK_ID };
    if (lift) input.lift = { version: 1 };
    else input.change = { version: 1, start: BLOCK.start, end: "2030-03-10T06:00:00.000Z" };
    await expect(venueModel.changeVenueBlock(input)).resolves.toMatchObject({ changed: true });
    expect(statements).toContain("COMMIT");
    expect(venueCalendarModel.revertBlock).not.toHaveBeenCalled();
  });

  test("reports uncertainty when both acknowledgement recovery and undo are unavailable", async () => {
    lockClient({ begin_venue_block: { replay: null, affectedEventIds: [42] }, record_venue_block: recorded() });
    venueCalendarModel.insertBlock.mockRejectedValue(new Error("offline"));
    venueCalendarModel.ownsBlockWrite.mockRejectedValue(new Error("offline"));
    venueCalendarModel.deleteBlock.mockRejectedValue(new Error("offline"));
    await expect(create()).rejects.toMatchObject({ code: "VENUE_CALENDAR_OUTCOME_UNKNOWN" });
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });
});


test.each([false, true])("registers change undo before the write returns (lift=%s)", async (lift) => {
  venueCalendarModel.findCalendarEntry.mockResolvedValue(blockEntry());
  lockClient({ begin_venue_block_change: { affectedEventIds: [] }, record_venue_block_change_once: { openIncidents: [] } });
  venueCalendarModel.updateBlock.mockRejectedValue(new Error("ack lost"));
  let undoWasBeforeRollback = false;
  venueCalendarModel.revertBlock.mockImplementation(async () => {
    undoWasBeforeRollback = !statements.includes("ROLLBACK");
  });
  const input = { actorId: VENUE_STAFF_ID, venueId: HALL, blockId: BLOCK_ID };
  if (lift) input.lift = { version: 1 };
  else input.change = { version: 1, start: BLOCK.start, end: "2030-03-10T06:00:00.000Z" };
  await expect(venueModel.changeVenueBlock(input)).rejects.toMatchObject({ code: "VENUE_CALENDAR_UNAVAILABLE" });
  expect(venueCalendarModel.revertBlock).toHaveBeenCalledWith(expect.objectContaining({
    blockId: BLOCK_ID, version: 2, writeToken: venueCalendarModel.updateBlock.mock.calls[0][0].writeToken,
  }));
  expect(undoWasBeforeRollback).toBe(true);
  expect(statements).toContain("ROLLBACK");
  expect(statements).not.toContain("COMMIT");
});

describe("durable block change recovery", () => {
  test.each([false, true])("repairs an uncertain change on retry before returning unchanged (lift=%s)", async (lift) => {
    let persisted = blockEntry();
    venueCalendarModel.findCalendarEntry.mockImplementation(async () => persisted);
    venueCalendarModel.updateBlock.mockImplementation(async (input) => {
      persisted = blockEntry({ start: input.start, end: input.end, version: 2,
        status: lift ? "LIFTED" : "ACTIVE", writeRecovery: input.writeRecovery });
      throw new Error("saved but disconnected");
    });
    venueCalendarModel.ownsBlockWrite.mockRejectedValue(new Error("offline"));
    venueCalendarModel.revertBlock.mockRejectedValue(new Error("offline"));
    venueCalendarModel.clearBlockRecovery.mockImplementation(async () => { persisted = { ...persisted, writeRecovery: null }; });
    lockClient({ begin_venue_block_change: { affectedEventIds: [] }, record_venue_block_change_once: { openIncidents: [] } });
    const args = { actorId: VENUE_STAFF_ID, venueId: HALL, blockId: BLOCK_ID };
    if (lift) args.lift = { version: 1 };
    else args.change = { version: 1, start: BLOCK.start, end: "2030-03-10T06:00:00.000Z" };
    await expect(venueModel.changeVenueBlock(args)).rejects.toMatchObject({ code: "VENUE_CALENDAR_OUTCOME_UNKNOWN" });
    expect(persisted.writeRecovery).toMatchObject({ actorId: VENUE_STAFF_ID, action: lift ? "LIFTED" : "SHORTENED" });
    expect(statements).toContain("ROLLBACK");
    // A new request needs only the intent read from MongoDB, no process memory.
    const beforeRetry = statements.length;
    await expect(venueModel.changeVenueBlock(args)).resolves.toMatchObject({ changed: false });
    expect(statements.slice(beforeRetry)).toEqual(["BEGIN", "SET", "begin_venue_block_change", "record_venue_block_change_once", "COMMIT"]);
    expect(persisted.writeRecovery).toBeNull();
    const beforeThird = statements.length;
    await expect(venueModel.changeVenueBlock(args)).resolves.toMatchObject({ changed: false });
    expect(statements.length).toBe(beforeThird);
  });

  test("retains the intent if recovery fails again, rather than reporting unchanged", async () => {
    const intent = { actorId: VENUE_STAFF_ID, action: "LIFTED", before: { start: BLOCK.start, end: BLOCK.end },
      after: { start: BLOCK.start, end: BLOCK.end }, eventIds: [42], writeToken: cryptoToken() };
    venueCalendarModel.findCalendarEntry.mockResolvedValue(blockEntry({ status: "LIFTED", version: 2, writeRecovery: intent }));
    lockClient({ begin_venue_block_change: { affectedEventIds: [42] },
      record_venue_block_change_once: () => { throw new Error("database unavailable"); } });
    await expect(venueModel.changeVenueBlock({ actorId: VENUE_STAFF_ID, venueId: HALL, blockId: BLOCK_ID, lift: { version: 1 } }))
      .rejects.toThrow("database unavailable");
    expect(venueCalendarModel.clearBlockRecovery).not.toHaveBeenCalled();
    expect(venueCalendarModel.updateBlock).not.toHaveBeenCalled();
  });
});
const cryptoToken = () => require("node:crypto").randomUUID();
