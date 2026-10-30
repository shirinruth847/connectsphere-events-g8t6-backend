// SPM-195 block validation (AC2, TC-02) and the pure block rules in
// venueConflictModel.js (AC3, AC9, T4).
const {
  validateBlockCreate,
  validateBlockChange,
  validateBlockLift,
  parseBlockId,
  BLOCK_REASONS,
} = require("../../validators/venueBlockValidator");
const {
  findHoldsUnderBlock,
  findActiveBlocks,
  canBeRestored,
  classifyBlockChange,
  BLOCK_CHANGE,
} = require("../../model/venueConflictModel");

const NOW = new Date("2030-03-01T00:00:00Z");
const body = (overrides = {}) => ({
  reason: "MAINTENANCE",
  start: "2030-03-10T13:00:00+08:00",
  end: "2030-03-10T15:00:00+08:00",
  note: "  Air conditioning repair  ",
  ...overrides,
});

describe("validateBlockCreate (SPM-195 AC2)", () => {
  test("should_accept_every_week_7_reason_and_trim_the_note", () => {
    for (const reason of BLOCK_REASONS) {
      const { block, fields } = validateBlockCreate(body({ reason }), { now: NOW });
      expect(fields).toBeUndefined();
      expect(block).toEqual({ reason, start: "2030-03-10T05:00:00.000Z", end: "2030-03-10T07:00:00.000Z", note: "Air conditioning repair" });
    }
  });

  test("[SPM-195-TC-02] should_require_reason_note_and_valid_times", () => {
    expect(validateBlockCreate({}, { now: NOW }).fields).toEqual({
      reason: expect.any(String), start: expect.any(String), end: expect.any(String), note: expect.any(String),
    });
    expect(validateBlockCreate(body({ end: "2030-03-10T13:00:00+08:00" }), { now: NOW }).fields.end).toBe("The end must be after the start.");
    expect(validateBlockCreate(body({ start: "2030-02-01T00:00:00Z", end: "2030-02-01T01:00:00Z" }), { now: NOW }).fields.end)
      .toBe("The end must be in the future.");
    expect(validateBlockCreate(body({ start: "2030-03-10T13:00:00" }), { now: NOW }).fields.start).toBeDefined();
    expect(validateBlockCreate(body({ note: "x".repeat(1001) }), { now: NOW }).fields.note).toBeDefined();
    expect(validateBlockCreate(body({ reason: "FLOOD" }), { now: NOW }).fields.reason).toBeDefined();
  });

  test("should_allow_a_block_that_already_started_but_ends_later", () => {
    const { block } = validateBlockCreate(body({ start: "2030-02-28T00:00:00Z", end: "2030-03-02T00:00:00Z" }), { now: NOW });
    expect(block).toBeDefined();
  });

  test("should_refuse_server_controlled_fields_and_overlong_blocks", () => {
    const { fields } = validateBlockCreate(body({ status: "LIFTED", setupMinutes: 0, end: "2031-06-01T00:00:00Z" }), { now: NOW });
    expect(Object.keys(fields).sort()).toEqual(["end", "setupMinutes", "status"]);
    expect(validateBlockCreate(null).fields.body).toBeDefined();
  });
});

describe("validateBlockChange and validateBlockLift (SPM-195 AC9)", () => {
  test("should_require_both_times_and_the_loaded_version", () => {
    expect(validateBlockChange({ start: body().start, end: body().end, version: 2 }).change)
      .toEqual({ start: "2030-03-10T05:00:00.000Z", end: "2030-03-10T07:00:00.000Z", version: 2 });
    expect(Object.keys(validateBlockChange({ end: body().end, version: 0, reason: "OTHER" }).fields).sort())
      .toEqual(["reason", "start", "version"]);
  });

  test("should_require_a_version_to_lift", () => {
    expect(validateBlockLift({ version: 3 }).lift).toEqual({ version: 3 });
    expect(validateBlockLift(undefined).fields.version).toBeDefined();
    expect(validateBlockLift({ version: 1, end: "x" }).fields.end).toBeDefined();
  });

  test("should_accept_only_object_ids", () => {
    expect(parseBlockId("a".repeat(24))).toBe("a".repeat(24));
    expect(parseBlockId("A".repeat(24))).toBeNull();
    expect(parseBlockId("123")).toBeNull();
  });
});

describe("block rules (SPM-195)", () => {
  const hold = (overrides) => ({
    id: "h1", type: "HOLD", venueId: 7, eventId: 5, status: "ACTIVE", holdExpiresAt: "2030-03-09T00:00:00Z",
    occupiedStart: "2030-03-10T06:00:00Z", occupiedEnd: "2030-03-10T07:00:00Z", ...overrides,
  });
  const block = { start: "2030-03-10T05:00:00Z", end: "2030-03-10T06:00:00Z", venueId: 7 };

  test("[SPM-195-AC3] should_find_active_holds_under_the_block_but_not_adjacent_ones", () => {
    const overlapping = hold({ occupiedStart: "2030-03-10T05:59:59Z" });
    const adjacent = hold({ id: "h2" });
    const expired = hold({ id: "h3", occupiedStart: "2030-03-10T05:00:00Z", holdExpiresAt: "2030-02-01T00:00:00Z" });
    const converted = hold({ id: "h4", occupiedStart: "2030-03-10T05:00:00Z", status: "CONVERTED" });
    expect(findHoldsUnderBlock([overlapping, adjacent, expired, converted], block, NOW).map((entry) => entry.id)).toEqual(["h1"]);
  });

  test("[SPM-195-AC9] should_restore_only_when_no_active_block_overlaps_the_whole_range", () => {
    const range = { start: "2030-03-10T06:00:00Z", end: "2030-03-10T08:00:00Z" };
    const activeBlock = (end) => ({ id: "b", type: "BLOCK", status: "ACTIVE", occupiedStart: "2030-03-10T05:00:00Z", occupiedEnd: end });
    expect(canBeRestored(range, [activeBlock("2030-03-10T06:00:00Z")])).toBe(true);
    expect(canBeRestored(range, [activeBlock("2030-03-10T06:00:01Z")])).toBe(false);
    expect(canBeRestored(range, [{ ...activeBlock("2030-03-10T09:00:00Z"), status: "LIFTED" }])).toBe(true);
    expect(canBeRestored(range, null)).toBeNull();
    expect(findActiveBlocks([activeBlock("2030-03-10T07:00:00Z")], range, { excludeBlockId: "b" })).toEqual([]);
  });

  test("[SPM-195-TC-13] should_classify_shorter_unchanged_and_longer_changes", () => {
    const current = { start: "2030-03-10T05:00:00Z", end: "2030-03-10T07:00:00Z" };
    expect(classifyBlockChange(current, { start: "2030-03-10T05:00:00.000Z", end: "2030-03-10T06:30:00Z" })).toBe(BLOCK_CHANGE.SHORTEN);
    expect(classifyBlockChange(current, { start: "2030-03-10T05:30:00Z", end: "2030-03-10T07:00:00Z" })).toBe(BLOCK_CHANGE.SHORTEN);
    expect(classifyBlockChange(current, { ...current })).toBe(BLOCK_CHANGE.UNCHANGED);
    expect(classifyBlockChange(current, { start: current.start, end: "2030-03-10T08:00:00Z" })).toBe(BLOCK_CHANGE.EXTEND);
    expect(classifyBlockChange(current, { start: "2030-03-10T04:59:00Z", end: "2030-03-10T06:00:00Z" })).toBe(BLOCK_CHANGE.EXTEND);
  });
});
