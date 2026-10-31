// Unit tests for model/activityModel.js: the audience filter, paging and the shape of
// change-history entries (SPM-33 AC8). Supabase is mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require("../../config/supabase");
const activityModel = require("../../model/activityModel");

const queryReturning = (result) => {
  const query = {};
  for (const method of ["select", "eq", "in", "lt", "order"]) {
    query[method] = jest.fn(() => query);
  }
  query.limit = jest.fn().mockResolvedValue(result);
  query.maybeSingle = jest.fn().mockResolvedValue(result);
  return query;
};

beforeEach(() => jest.clearAllMocks());

describe("activityModel (AC8)", () => {
  const historyRow = (overrides = {}) => ({
    log_id: 9,
    user_id: 21,
    action: "EVENT_DETAILS_UPDATED",
    details: "Event details updated.",
    timestamp: "2026-10-12T08:00:00+00:00",
    actor_role: "COORDINATOR",
    audience: "ORGANISER_SAFE",
    changes: { description: { before: "Old", after: "New" } },
    actor: { name: "Coordinator C" },
    ...overrides,
  });

  test("[SPM-33-TC-19] should_filter_to_the_readers_audiences_in_the_query", async () => {
    const query = queryReturning({ data: [historyRow()], error: null });
    supabase.from.mockReturnValue(query);

    const { history, nextCursor } = await activityModel.findEventHistory(42, { limit: 20, audiences: ["ORGANISER_SAFE"] });

    expect(supabase.from).toHaveBeenCalledWith("activity_log");
    expect(query.eq).toHaveBeenCalledWith("entity_name", "event");
    expect(query.eq).toHaveBeenCalledWith("entity_id", 42);
    expect(query.in).toHaveBeenCalledWith("audience", ["ORGANISER_SAFE"]);
    expect(history).toEqual([
      {
        historyId: 9,
        action: "EVENT_DETAILS_UPDATED",
        actor: { userId: 21, name: "Coordinator C", role: "COORDINATOR" },
        occurredAt: "2026-10-12T08:00:00+00:00",
        summary: "Event details updated.",
        changes: [{ field: "description", before: "Old", after: "New" }],
        audience: "ORGANISER_SAFE",
      },
    ]);
    expect(nextCursor).toBeNull();
  });

  test("[SPM-33-TC-05] should_ask_for_exactly_the_audiences_it_is_given", async () => {
    const query = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(query);

    await activityModel.findEventHistory(42, { limit: 20, audiences: ["ORGANISER_SAFE", "STAFF_ONLY"] });

    expect(query.in).toHaveBeenCalledWith("audience", ["ORGANISER_SAFE", "STAFF_ONLY"]);
  });

  test("[SPM-33-AC8] should_return_nothing_without_querying_when_the_reader_has_no_audience", async () => {
    await expect(activityModel.findEventHistory(42, { limit: 20 })).resolves.toEqual({ history: [], nextCursor: null });
    await expect(activityModel.findEventHistory(42, { limit: 20, audiences: [] })).resolves.toEqual({ history: [], nextCursor: null });

    expect(supabase.from).not.toHaveBeenCalled();
  });

  test("[SPM-33-AC8] should_page_newest_first_with_a_cursor_on_the_entry_id", async () => {
    const firstPage = queryReturning({ data: [historyRow({ log_id: 9 }), historyRow({ log_id: 8 }), historyRow({ log_id: 7 })], error: null });
    supabase.from.mockReturnValue(firstPage);

    const { history, nextCursor } = await activityModel.findEventHistory(42, { limit: 2, audiences: ["ORGANISER_SAFE", "STAFF_ONLY"] });

    expect(history.map(({ historyId }) => historyId)).toEqual([9, 8]);
    expect(firstPage.order).toHaveBeenCalledWith("log_id", { ascending: false });
    expect(firstPage.limit).toHaveBeenCalledWith(3);
    expect(activityModel.decodeHistoryCursor(nextCursor)).toBe(8);

    const secondPage = queryReturning({ data: [], error: null });
    supabase.from.mockReturnValue(secondPage);
    await activityModel.findEventHistory(42, { limit: 2, cursor: nextCursor, audiences: ["ORGANISER_SAFE", "STAFF_ONLY"] });

    expect(secondPage.lt).toHaveBeenCalledWith("log_id", 8);
  });

  test.each([
    ["not base64 json", "not-a-cursor"],
    ["a text id", Buffer.from(JSON.stringify({ logId: "8" })).toString("base64url")],
    ["a filter injection", Buffer.from(JSON.stringify({ logId: "1,audience.eq.STAFF_ONLY" })).toString("base64url")],
  ])("[SPM-33-AC8] should_reject_the_cursor_when_it_is_%s", (_label, cursor) => {
    expect(() => activityModel.decodeHistoryCursor(cursor)).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
  });

  test("[SPM-33-AC8] should_raise_a_cursor_error_the_controller_answers_with_400", () => {
    // handleError maps only errors named EventRequestError to a 400.
    expect(() => activityModel.decodeHistoryCursor("not-a-cursor")).toThrow(
      expect.objectContaining({ name: "EventRequestError", code: "INVALID_CURSOR", message: "INVALID_CURSOR" })
    );
  });

  test.each([
    ["plain text from older rows", "Ramp access", "Ramp access"],
    ["text that only looks like a list", "[Ramp access", "[Ramp access"],
    ["no value", null, null],
    ["a missing value", undefined, null],
  ])("[SPM-33-AC8] should_show_accessibility_needs_saved_as_%s_unchanged", (_label, stored, shown) => {
    const [change] = activityModel.toChangeList({ accessibilityNeeds: { before: stored, after: "[]" } });
    expect(change).toEqual({ field: "accessibilityNeeds", before: shown, after: [] });
  });

  test("[SPM-33-TC-07] should_show_changed_values_in_api_shapes_and_a_stable_order", () => {
    const changes = activityModel.toChangeList({
      equipmentRequirements: { before: [], after: [{ equipment_id: 3, quantity: 2 }] },
      accessibilityNeeds: { before: null, after: '["Wheelchair access"]' },
      expectedAttendance: { before: 50, after: 200 },
    });

    expect(changes).toEqual([
      { field: "expectedAttendance", before: 50, after: 200 },
      { field: "accessibilityNeeds", before: null, after: ["Wheelchair access"] },
      { field: "equipmentRequirements", before: [], after: [{ equipmentId: 3, quantity: 2 }] },
    ]);
  });

  test("[SPM-33-AC8] should_return_no_changes_for_entries_recorded_without_them", () => {
    expect(activityModel.toHistoryEntry(historyRow({ changes: null, actor: null, actor_role: null }))).toEqual(
      expect.objectContaining({ changes: [], actor: { userId: 21, name: null, role: null } })
    );
  });
});

describe("history views (SPM-41 v2)", () => {
  test("[SPM-41-AC5] should_read_when_this_person_last_viewed_the_events_history", async () => {
    const query = queryReturning({ data: { last_viewed_at: "2026-10-23T03:00:00+00:00" }, error: null });
    supabase.from.mockReturnValue(query);

    await expect(activityModel.findLastHistoryView(42, 11)).resolves.toBe("2026-10-23T03:00:00+00:00");
    expect(supabase.from).toHaveBeenCalledWith("event_history_views");
    expect(query.eq).toHaveBeenCalledWith("event_id", 42);
    expect(query.eq).toHaveBeenCalledWith("user_id", 11);
  });

  test("[SPM-41-AC5] should_return_null_before_the_first_view_and_throw_when_the_read_fails", async () => {
    supabase.from.mockReturnValueOnce(queryReturning({ data: null, error: null }));
    await expect(activityModel.findLastHistoryView(42, 11)).resolves.toBeNull();

    supabase.from.mockReturnValueOnce(queryReturning({ data: null, error: { message: "permission denied" } }));
    await expect(activityModel.findLastHistoryView(42, 11)).rejects.toThrow("permission denied");
  });

  test("[SPM-41-AC5] should_record_a_view_through_the_database_function", async () => {
    supabase.rpc.mockResolvedValue({ data: "2026-10-24T03:00:00+00:00", error: null });

    await expect(activityModel.markEventHistoryViewed(42, 11)).resolves.toBe("2026-10-24T03:00:00+00:00");
    expect(supabase.rpc).toHaveBeenCalledWith("mark_event_history_viewed", { p_event_id: 42, p_actor_id: 11 });
  });
});


test("[SPM-38] organiser history uses backend labels while staff retain detailed states", () => {
  const row = { log_id: 1, changes: { status: { before: "PLANNING", after: "SAFETY_REVIEW" } } };
  const change = activityModel.toHistoryEntry(row, { organiserView: true }).changes[0];
  expect(change).toMatchObject({ beforeLabel: "Approved & Planning", afterLabel: "Approved & Planning" });
  expect(activityModel.toHistoryEntry(row).changes[0]).not.toHaveProperty("afterLabel");
});

test("[SPM-286][SPM-287] a technical request entry shows only its labelled status change", () => {
  const row = { log_id: 2, action: "TECHNICAL_REQUEST_APPROVED", changes: { technicalRequestStatus: { before: "PENDING", after: "APPROVED" } } };
  for (const organiserView of [true, false]) {
    expect(activityModel.toHistoryEntry(row, { organiserView }).changes).toEqual([
      { field: "technicalRequestStatus", label: "Technical request", before: "PENDING", after: "APPROVED", beforeLabel: "Pending", afterLabel: "Approved" },
    ]);
  }
  const sent = activityModel.toHistoryEntry({ log_id: 3, changes: { technicalRequestStatus: { before: null, after: "PENDING" } } });
  expect(sent.changes[0]).toMatchObject({ beforeLabel: null, afterLabel: "Pending" });
});
