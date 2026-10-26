// The PostgreSQL outbox for MongoDB writes (Master 7.3). Entries are written by
// the database functions that make each change, in the same transaction; this
// model claims them with a lease, applies them through the detail model and
// records the result. Entries are never deleted.
const supabase = require("../config/supabase");
const equipmentDetailModel = require("./equipmentDetailModel");
const { OUTBOX, OUTBOX_STATE } = require("../config/equipmentConstants");

const APPLIERS = Object.freeze({
  equipment_details: (entry) => equipmentDetailModel.applyEquipmentDetail({
    equipmentId: entry.document_id,
    pgVersion: entry.pg_version,
    payload: entry.payload || {},
  }),
});

const callRpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(`[Supabase Error] ${name}: ${error.message}`);
  return data;
};

// Only the error's kind and a short message are kept: driver messages can name
// hosts, never credentials, and the column is bounded anyway.
const describeFailure = (error) => `${error.name || "Error"}: ${String(error.message || "").slice(0, 300)}`;

// MongoDB could not be reached at all (not configured, DNS lookup failed,
// refused, timed out). That is an outage to retry, not an entry that keeps
// failing (Master 7.3), so it never counts towards FAILED. Every developer's
// backend runs the sync job against the shared outbox, so one without Atlas
// access must not use up the attempts of everyone's entries.
const UNREACHABLE_ERRORS = new Set([
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
  "MongoPoolClearedError",
  "MongoServerClosedError",
]);
// A failed mongodb+srv lookup reaches us as a plain Error carrying the DNS or
// socket code (for example querySrv ENOTFOUND or ETIMEOUT).
const UNREACHABLE_CODES = new Set(["MONGODB_NOT_CONFIGURED", "ENOTFOUND", "ETIMEOUT", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET"]);
const isMongoUnreachable = (error) => UNREACHABLE_CODES.has(error?.code) || UNREACHABLE_ERRORS.has(error?.name);

// applyEntry result when MongoDB could not be reached.
const UNREACHABLE = "UNREACHABLE";

const releaseEntry = (entry, error) =>
  callRpc("release_outbox_entry", { p_entry_id: entry.entry_id, p_claim_generation: entry.claim_generation, p_error: describeFailure(error), p_retry_seconds: OUTBOX.RETRY_SECONDS });

// Applies one claimed entry and records the outcome. Returns APPLIED, PENDING
// (will be retried), FAILED (gave up after the attempt limit) or UNREACHABLE
// (MongoDB could not be reached; handed back without counting an attempt), or
// STALE_CLAIM when another worker owns the result. Every result carries the
// generation returned by the claim, so an expired worker cannot change it.
const applyEntry = async (entry, maxAttempts = OUTBOX.MAX_ATTEMPTS) => {
  if (entry.claim_generation == null) throw new Error("Outbox entry has no claim generation; apply the claim-ownership migration first.");
  const apply = APPLIERS[entry.target_collection];
  try {
    if (!apply) throw new Error(`No applier for ${entry.target_collection}`);
    await apply(entry);
  } catch (error) {
    if (isMongoUnreachable(error)) {
      await releaseEntry(entry, error);
      return UNREACHABLE;
    }
    return (await callRpc("fail_outbox_entry", {
      p_entry_id: entry.entry_id,
      p_claim_generation: entry.claim_generation,
      p_error: describeFailure(error),
      p_max_attempts: maxAttempts,
    })) || "STALE_CLAIM";
  }
  const completed = await callRpc("complete_outbox_entry", { p_entry_id: entry.entry_id, p_claim_generation: entry.claim_generation });
  return completed ? OUTBOX_STATE.APPLIED : "STALE_CLAIM";
};

// The request handler's one attempt right after commit (Master 7.3 step 2).
// Returns null when the job already holds the entry.
const applyEntryNow = async (entryId, maxAttempts = OUTBOX.MAX_ATTEMPTS) => {
  if (!entryId) return null;
  const claimed = await callRpc("claim_outbox_entry", {
    p_entry_id: entryId,
    p_lease_seconds: OUTBOX.LEASE_SECONDS,
    p_max_attempts: maxAttempts,
  });
  if (!claimed || !claimed.length) return null;
  return applyEntry(claimed[0], maxAttempts);
};

// True when the detail store answers. The job checks this before claiming, so a
// backend that cannot reach MongoDB leaves the shared outbox untouched.
const canReachDetailStore = async () => {
  try {
    await equipmentDetailModel.pingEquipmentDetails();
    return true;
  } catch (error) {
    if (isMongoUnreachable(error)) return false;
    throw error;
  }
};

// One batch for the sync job: { claimed, unreachable }. When MongoDB stops
// answering part-way, the rest of the batch is handed back at once rather than
// each entry waiting for its own connection timeout.
const processDueEntries = async (limit = OUTBOX.BATCH_SIZE, maxAttempts = OUTBOX.MAX_ATTEMPTS) => {
  if (!(await canReachDetailStore())) return { claimed: 0, unreachable: true };
  const entries = (await callRpc("claim_outbox_entries", {
    p_limit: limit,
    p_lease_seconds: OUTBOX.LEASE_SECONDS,
    p_max_attempts: maxAttempts,
  })) || [];
  for (const [index, entry] of entries.entries()) {
    if ((await applyEntry(entry, maxAttempts)) === UNREACHABLE) {
      const error = Object.assign(new Error("MongoDB became unreachable during the batch"), { name: "MongoNetworkError" });
      for (const rest of entries.slice(index + 1)) await releaseEntry(rest, error);
      return { claimed: entries.length, unreachable: true };
    }
  }
  return { claimed: entries.length, unreachable: false };
};

const selectEntries = async (targetCollection, documentIds, states) => {
  const { data, error } = await supabase
    .from("outbox_entries")
    .select("document_id,pg_version,state")
    .eq("target_collection", targetCollection)
    .in("document_id", documentIds)
    .in("state", states)
    .order("pg_version", { ascending: false });
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data;
};

const newestByDocument = (rows) => {
  const newest = new Map();
  for (const row of rows) {
    if (!newest.has(row.document_id)) newest.set(row.document_id, row);
  }
  return newest;
};

// Documents whose newest entry has not been applied yet, as a Map of document
// ID -> PENDING or FAILED. A stale entry older than an applied one does not
// count: the document already holds newer data. Only unapplied entries and the
// applied ones of those documents are read, so the result stays small.
const findUnappliedDocuments = async (targetCollection, documentIds) => {
  const ids = documentIds.map(String);
  if (!ids.length) return new Map();
  const unapplied = newestByDocument(await selectEntries(targetCollection, ids, [OUTBOX_STATE.PENDING, OUTBOX_STATE.FAILED]));
  if (!unapplied.size) return new Map();
  const applied = newestByDocument(await selectEntries(targetCollection, [...unapplied.keys()], [OUTBOX_STATE.APPLIED]));
  const behind = new Map();
  for (const [documentId, entry] of unapplied) {
    const newestApplied = applied.get(documentId);
    if (!newestApplied || newestApplied.pg_version < entry.pg_version) behind.set(documentId, entry.state);
  }
  return behind;
};

// The payload of the document's newest entry: what PostgreSQL last wrote for it,
// whether or not MongoDB has applied it yet. Null when it has no entry.
const findLatestPayload = async (targetCollection, documentId) => {
  const { data, error } = await supabase
    .from("outbox_entries")
    .select("payload")
    .eq("target_collection", targetCollection)
    .eq("document_id", String(documentId))
    .order("pg_version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data ? data.payload : null;
};

module.exports = {
  applyEntry,
  applyEntryNow,
  processDueEntries,
  findUnappliedDocuments,
  findLatestPayload,
  isMongoUnreachable,
  UNREACHABLE,
};
