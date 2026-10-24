// SPM-52 outbox processing and the sync job with the database and MongoDB mocked.
jest.mock("../../config/supabase", () => ({ rpc: jest.fn(), from: jest.fn() }));
jest.mock("../../model/equipmentDetailModel", () => ({ applyEquipmentDetail: jest.fn() }));

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

beforeEach(() => jest.clearAllMocks());

describe("SPM-52 applying entries", () => {
  test("[AC10] should_apply_then_mark_the_entry_applied", async () => {
    rpcAnswers({ complete_outbox_entry: () => true });

    await expect(outboxModel.applyEntry(entry(7))).resolves.toBe("APPLIED");

    expect(equipmentDetailModel.applyEquipmentDetail).toHaveBeenCalledWith({ equipmentId: "41", pgVersion: 2, payload: { name: "Mixer" } });
    expect(supabase.rpc).toHaveBeenCalledWith("complete_outbox_entry", { p_entry_id: 7 });
  });

  test("[TC-12] should_record_a_retry_when_mongodb_is_unavailable", async () => {
    equipmentDetailModel.applyEquipmentDetail.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { name: "MongoServerSelectionError" }));
    rpcAnswers({ fail_outbox_entry: () => "PENDING" });

    await expect(outboxModel.applyEntry(entry(7))).resolves.toBe("PENDING");

    expect(supabase.rpc).toHaveBeenCalledWith("fail_outbox_entry", {
      p_entry_id: 7,
      p_error: "MongoServerSelectionError: connect ECONNREFUSED",
      p_max_attempts: OUTBOX.MAX_ATTEMPTS,
    });
    expect(supabase.rpc).not.toHaveBeenCalledWith("complete_outbox_entry", expect.anything());
  });

  test("[TC-19] should_report_failed_once_the_database_gives_up", async () => {
    equipmentDetailModel.applyEquipmentDetail.mockRejectedValue(new Error("down"));
    rpcAnswers({ fail_outbox_entry: () => "FAILED" });

    await expect(outboxModel.applyEntry(entry(7))).resolves.toBe("FAILED");
  });

  test("[AC10] should_skip_the_post_commit_attempt_when_the_job_holds_the_entry", async () => {
    rpcAnswers({ claim_outbox_entry: () => [] });

    await expect(outboxModel.applyEntryNow(7)).resolves.toBeNull();
    expect(equipmentDetailModel.applyEquipmentDetail).not.toHaveBeenCalled();
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

    await expect(runMongoSync()).resolves.toBe(OUTBOX.BATCH_SIZE + 2);
    expect(call).toBe(2);
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
