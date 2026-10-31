// SPM-186: the queries behind the Venue Staff history views.
jest.mock("../../config/supabase", () => ({ from: jest.fn() }));

const supabase = require("../../config/supabase");
const activityModel = require("../../model/activityModel");

const queryReturning = (result) => {
  const calls = [];
  const query = { calls, then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
  for (const method of ["select", "eq", "in", "or", "lt", "order", "limit"]) {
    query[method] = jest.fn((...args) => {
      calls.push([method, ...args]);
      return query;
    });
  }
  return query;
};

const logRow = (logId, action) => ({
  log_id: logId, user_id: 7, action, details: action, timestamp: "2026-10-29T01:00:00Z",
  actor_role: "VENUE_STAFF", changes: { status: { before: "ACTIVE", after: "UNDER_MAINTENANCE" } },
  audience: "STAFF_ONLY", actor: { name: "Venue Staff A" },
});

beforeEach(() => jest.clearAllMocks());

describe("findEventHistory for Venue Staff", () => {
  test("[SPM-186-AC15] should_keep_venue_entries_and_changes_to_what_a_booking_depends_on", async () => {
    const query = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(query);

    await activityModel.findEventHistory(442, {
      limit: 20, audiences: ["ORGANISER_SAFE", "STAFF_ONLY"], fields: ["startDatetime", "venueBookings"], actionPattern: "VENUE_*",
    });

    expect(query.calls).toContainEqual(["in", "audience", ["ORGANISER_SAFE", "STAFF_ONLY"]]);
    expect(query.calls).toContainEqual(["or", "action.like.VENUE_*,changes->startDatetime.not.is.null,changes->venueBookings.not.is.null"]);
  });

  test("should_keep_the_safety_officer_filter_by_default", async () => {
    const query = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(query);

    await activityModel.findEventHistory(442, { limit: 20, audiences: ["STAFF_ONLY"], fields: ["venueBookings"] });

    expect(query.calls).toContainEqual(["or", "action.like.SAFETY_*,changes->venueBookings.not.is.null"]);
  });
});

describe("findVenueHistory", () => {
  test("[SPM-186-AC15] should_read_the_venue's_staff_only_entries_newest_first_with_a_cursor", async () => {
    const query = queryReturning({ data: [logRow(30, "VENUE_STATUS_CHANGED"), logRow(29, "VENUE_UPDATED"), logRow(28, "VENUE_CREATED")], error: null });
    supabase.from.mockReturnValue(query);

    const result = await activityModel.findVenueHistory(45, { limit: 2 });

    expect(supabase.from).toHaveBeenCalledWith("activity_log");
    expect(query.calls).toEqual(expect.arrayContaining([
      ["eq", "entity_name", "venue"],
      ["eq", "entity_id", 45],
      ["eq", "audience", "STAFF_ONLY"],
      ["order", "log_id", { ascending: false }],
      ["limit", 3],
    ]));
    expect(result.history.map((entry) => entry.historyId)).toEqual([30, 29]);
    expect(result.history[0]).toMatchObject({
      action: "VENUE_STATUS_CHANGED",
      actor: { userId: 7, name: "Venue Staff A", role: "VENUE_STAFF" },
      changes: [{ field: "status", before: "ACTIVE", after: "UNDER_MAINTENANCE" }],
    });
    expect(result.nextCursor).toEqual(expect.any(String));

    const next = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(next);
    await activityModel.findVenueHistory(45, { limit: 2, cursor: result.nextCursor });
    expect(next.calls).toContainEqual(["lt", "log_id", 29]);
  });

  test("should_refuse_a_tampered_cursor", async () => {
    await expect(activityModel.findVenueHistory(45, { limit: 2, cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});
