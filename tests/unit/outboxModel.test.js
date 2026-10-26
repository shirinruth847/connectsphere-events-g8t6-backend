// SPM-52 outbox processing and the sync job with the database and MongoDB mocked.
jest.mock("../../config/supabase", () => ({ rpc: jest.fn(), from: jest.fn() }));
jest.mock("../../model/equipmentDetailModel", () => ({ applyEquipmentDetail: jest.fn(), pingEquipmentDetails: jest.fn() }));

const supabase = require("../../config/supabase");
const equipmentDetailModel = require("../../model/equipmentDetailModel");
const outboxModel = require("../../model/outboxModel");
const { runMongoSync, readIntervalMs } = require("../../jobs/mongoSyncJob");
const { OUTBOX } = require("../../config/equipmentConstants");

const entry = (id, extra = {}) => ({ entry_id: id, target_collection: "equipment_details", document_id: "41", pg_version: 2, payload: { name: "Mixer" }, ...extra });

// rpc(name, args) answers from a table of handlers.
const rpcAnswers = (handlers) => {
  supabase.rpc.mockImplementation(async (name, args) => ({ data: handlers[name] ? handlers[name](args) : null, error: null }));
};

const unreachable = () => Object.assign(new Error("connect ECONNREFUSED"), { name: "MongoServerSelectionError" });

beforeEach(() => {
  jest.clearAllMocks();
  equipmentDetailModel.pingEquipmentDetails.mockReset().mockResolvedValue(undefined);
  equipmentDetailModel.applyEquipmentDetail.mockReset().mockResolvedValue(true);
});

describe("SPM-52 applying entries", () => {
  test("[AC10] should_apply_then_mark_the_entry_applied", async () => {
    rpcAnswers({ complete_outbox_entry: () => true });

    await expect(outboxModel.applyEntry(entry(7))).resolves.toBe("APPLIED");

    expect(equipmentDetailModel.applyEquipmentDetail).toHaveBeenCalledWith({ equipmentId: "41", pgVersion: 2, payload: { name: "Mixer" } });
    expect(supabase.rpc).toHaveBeenCalledWith("complete_outbox_entry", { p_entry_id: 7 });
  });

  test.each([
    ["MongoServerSelectionError", unreachable()],
    ["MongoNetworkError", Object.assign(new Error("socket closed"), { name: "MongoNetworkError" })],
    ["MONGODB_NOT_CONFIGURED", Object.assign(new Error("MongoDB is not configured."), { code: "MONGODB_NOT_CONFIGURED" })],
  ])("[TC-12] should_hand_the_entry_back_without_counting_an_attempt_on_%s", async (_kind, error) => {
    equipmentDetailModel.applyEquipmentDetail.mockRejectedValue(error);
    rpcAnswers({ release_outbox_entry: () => true });

    await expect(outboxModel.applyEntry(entry(7))).resolves.toBe(outboxModel.UNREACHABLE);

    expect(supabase.rpc).toHaveBeenCalledWith("release_outbox_entry", {
      p_entry_id: 7,
      p_error: expect.stringContaining(error.message),
      p_retry_seconds: OUTBOX.RETRY_SECONDS,
    });
    expect(supabase.rpc).not.toHaveBeenCalledWith("fail_outbox_entry", expect.anything());
    expect(supabase.rpc).not.toHaveBeenCalledWith("complete_outbox_entry", expect.anything());
  });

  test("[TC-19] should_count_an_attempt_when_mongodb_refuses_the_document", async () => {
    equipmentDetailModel.applyEquipmentDetail.mockRejectedValue(Object.assign(new Error("Document failed validation"), { name: "MongoServerError", code: 121 }));
    rpcAnswers({ fail_outbox_entry: () => "PENDING" });

    await expect(outboxModel.applyEntry(entry(7))).resolves.toBe("PENDING");

    expect(supabase.rpc).toHaveBeenCalledWith("fail_outbox_entry", {
      p_entry_id: 7,
      p_error: "MongoServerError: Document failed validation",
      p_max_attempts: OUTBOX.MAX_ATTEMPTS,
    });
  });

  test("[TC-19] should_report_failed_once_the_database_gives_up", async () => {
    equipmentDetailModel.applyEquipmentDetail.mockRejectedValue(new Error("Document failed validation"));
    rpcAnswers({ fail_outbox_entry: () => "FAILED" });

    await expect(outboxModel.applyEntry(entry(7))).resolves.toBe("FAILED");
  });

  test("[AC10] should_skip_the_post_commit_attempt_when_the_job_holds_the_entry", async () => {
    rpcAnswers({ claim_outbox_entry: () => [] });

    await expect(outboxModel.applyEntryNow(7)).resolves.toBeNull();
    expect(equipmentDetailModel.applyEquipmentDetail).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith("claim_outbox_entry", {
      p_entry_id: 7,
      p_lease_seconds: OUTBOX.LEASE_SECONDS,
      p_max_attempts: OUTBOX.MAX_ATTEMPTS,
    });
  });
});

describe("SPM-52 sync job", () => {
  test("[7.3] should_drain_full_batches_and_stop_at_a_short_one", async () => {
    let call = 0;
    rpcAnswers({
      claim_outbox_entries: () => {
        call += 1;
        const size = call === 1 ? OUTBOX.BATCH_SIZE : 2;
        return Array.from({ length: size }, (_, index) => entry(call * 1000 + index));
      },
      complete_outbox_entry: () => true,
    });

    await expect(runMongoSync()).resolves.toEqual({ processed: OUTBOX.BATCH_SIZE + 2, unreachable: false });
    expect(call).toBe(2);
  });

  test("[7.3] should_claim_nothing_when_mongodb_cannot_be_reached", async () => {
    equipmentDetailModel.pingEquipmentDetails.mockRejectedValue(unreachable());
    rpcAnswers({});

    await expect(runMongoSync()).resolves.toEqual({ processed: 0, unreachable: true });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("[7.3] should_hand_back_the_rest_of_the_batch_when_mongodb_drops_part_way", async () => {
    equipmentDetailModel.applyEquipmentDetail.mockResolvedValueOnce(true).mockRejectedValue(unreachable());
    rpcAnswers({
      claim_outbox_entries: () => [entry(1), entry(2), entry(3), entry(4)],
      complete_outbox_entry: () => true,
      release_outbox_entry: () => true,
    });

    await expect(runMongoSync()).resolves.toEqual({ processed: 4, unreachable: true });

    expect(equipmentDetailModel.applyEquipmentDetail).toHaveBeenCalledTimes(2);
    const released = supabase.rpc.mock.calls.filter(([name]) => name === "release_outbox_entry").map(([, args]) => args.p_entry_id);
    expect(released).toEqual([2, 3, 4]);
    expect(supabase.rpc).not.toHaveBeenCalledWith("fail_outbox_entry", expect.anything());
  });

  test("[7.3] should_stop_after_the_batch_limit_when_the_backlog_is_large", async () => {
    let calls = 0;
    rpcAnswers({
      claim_outbox_entries: () => {
        calls += 1;
        return Array.from({ length: OUTBOX.BATCH_SIZE }, (_, index) => entry(calls * 1000 + index));
      },
      complete_outbox_entry: () => true,
    });

    await runMongoSync();
    expect(calls).toBe(OUTBOX.MAX_BATCHES_PER_RUN);
  });

  test("[7.3] should_read_the_interval_and_allow_turning_the_job_off", () => {
    const saved = process.env.MONGO_SYNC_INTERVAL_MS;
    process.env.MONGO_SYNC_INTERVAL_MS = "0";
    expect(readIntervalMs()).toBe(0);
    process.env.MONGO_SYNC_INTERVAL_MS = "abc";
    expect(readIntervalMs()).toBe(OUTBOX.DEFAULT_INTERVAL_MS);
    if (saved === undefined) delete process.env.MONGO_SYNC_INTERVAL_MS;
    else process.env.MONGO_SYNC_INTERVAL_MS = saved;
  });
});
