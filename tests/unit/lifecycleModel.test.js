// SPM-173 unit tests for the pure parts: error mapping from the lifecycle
// functions, organiser labels and notes, the completion job and "System" history.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));

const supabase = require("../../config/supabase");
const eventModel = require("../../model/eventModel");
const { toHistoryEntry } = require("../../model/activityModel");
const { LABEL_STATUSES, STATUS_LABELS } = require("../../config/eventConstants");
const { runEventCompletion, readIntervalMs, BATCH_SIZE, MAX_BATCHES_PER_RUN } = require("../../jobs/eventCompletionJob");

beforeEach(() => jest.clearAllMocks());

describe("lifecycle error mapping", () => {
  test("[SPM-173-AC3] should_carry_the_current_status_of_a_refused_action", () => {
    const error = eventModel.toEventRequestError({ message: "TRANSITION_NOT_ALLOWED", details: "PLANNING", code: "P0001" });
    expect(error).toMatchObject({ name: "EventRequestError", code: "TRANSITION_NOT_ALLOWED", currentStatus: "PLANNING" });
  });

  test("[SPM-173-AC9] should_split_the_failing_readiness_codes", () => {
    const error = eventModel.toEventRequestError({ message: "READINESS_BLOCKED", details: "NO_ACTIVE_BOOKING,OPEN_CHANGE_REQUEST" });
    expect(error.failures).toEqual(["NO_ACTIVE_BOOKING", "OPEN_CHANGE_REQUEST"]);
  });

  test("should_keep_existing_version_conflicts_without_a_status", () => {
    const error = eventModel.toEventRequestError({ message: "EVENT_VERSION_CONFLICT" });
    expect(error.code).toBe("EVENT_VERSION_CONFLICT");
    expect(error.currentStatus).toBeUndefined();
  });

  test("should_send_the_version_and_a_scoped_request_hash_to_the_action_function", async () => {
    supabase.rpc.mockResolvedValue({ data: { event: { event_id: 42 }, replayed: false }, error: null });
    await eventModel.runLifecycleAction({ action: "CONFIRM", eventId: 42, actorId: 21, expectedVersion: 7, idempotencyKey: "key-12345678" });
    expect(supabase.rpc).toHaveBeenCalledWith("confirm_event", {
      p_event_id: 42,
      p_actor_id: 21,
      p_expected_version: 7,
      p_idempotency_key: "key-12345678",
      p_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});

describe("organiser labels (SPM-173 AC6)", () => {
  test("[SPM-173-TC-09] should_map_every_label_back_to_exactly_its_statuses", () => {
    for (const [status, label] of Object.entries(STATUS_LABELS)) {
      expect(LABEL_STATUSES[label]).toContain(status);
    }
    expect(LABEL_STATUSES["Approved & Planning"]).toEqual(["PLANNING", "SAFETY_REVIEW"]);
    expect(LABEL_STATUSES.Confirmed).toEqual(["CONFIRMED", "PREPARATION"]);
  });

  test.each([
    ["PLANNING", true, "Reconfirmation pending"],
    ["SAFETY_REVIEW", true, "Reconfirmation pending"],
    ["PLANNING", false, null],
    ["CONFIRMED", true, null],
  ])("[SPM-173-TC-09] should_note_reconfirmation_for_%s_previously_confirmed_%s", (status, previouslyConfirmed, note) => {
    expect(eventModel.toStatusNote({ status, previously_confirmed: previouslyConfirmed, coordinator_id: 5 })).toBe(note);
  });
});

describe("event completion job (SPM-173 AC12)", () => {
  test("should_drain_a_backlog_in_bounded_batches", async () => {
    supabase.rpc
      .mockResolvedValueOnce({ data: BATCH_SIZE, error: null })
      .mockResolvedValueOnce({ data: 3, error: null });
    await expect(runEventCompletion()).resolves.toBe(BATCH_SIZE + 3);
    expect(supabase.rpc).toHaveBeenCalledTimes(2);
    expect(supabase.rpc).toHaveBeenCalledWith("complete_due_events", { p_limit: BATCH_SIZE });
  });

  test("should_stop_after_the_batch_limit", async () => {
    supabase.rpc.mockResolvedValue({ data: BATCH_SIZE, error: null });
    await expect(runEventCompletion()).resolves.toBe(BATCH_SIZE * MAX_BATCHES_PER_RUN);
    expect(supabase.rpc).toHaveBeenCalledTimes(MAX_BATCHES_PER_RUN);
  });

  test("should_read_the_interval_and_allow_turning_the_job_off", () => {
    const original = process.env.EVENT_COMPLETION_INTERVAL_MS;
    process.env.EVENT_COMPLETION_INTERVAL_MS = "0";
    expect(readIntervalMs()).toBe(0);
    process.env.EVENT_COMPLETION_INTERVAL_MS = "abc";
    expect(readIntervalMs()).toBe(60000);
    if (original === undefined) delete process.env.EVENT_COMPLETION_INTERVAL_MS;
    else process.env.EVENT_COMPLETION_INTERVAL_MS = original;
  });
});

test("[SPM-173-AC4][SPM-173-TC-06] should_show_job_entries_as_System", () => {
  const entry = toHistoryEntry({
    log_id: 9,
    user_id: null,
    action: "EVENT_COMPLETED",
    details: "Completed automatically after the event ended.",
    timestamp: "2026-10-28T03:00:00Z",
    actor_role: "SYSTEM",
    changes: { status: { before: "PREPARATION", after: "COMPLETED" } },
    audience: "ORGANISER_SAFE",
    actor: null,
  });
  expect(entry.actor).toEqual({ userId: null, name: "System", role: "SYSTEM" });
  expect(entry.changes).toEqual([{ field: "status", before: "PREPARATION", after: "COMPLETED" }]);
});
