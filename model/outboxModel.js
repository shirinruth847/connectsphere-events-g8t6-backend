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

// Applies one claimed entry and records the outcome. Returns APPLIED, PENDING
// (will be retried) or FAILED (gave up after the attempt limit).
const applyEntry = async (entry, maxAttempts = OUTBOX.MAX_ATTEMPTS) => {
  const apply = APPLIERS[entry.target_collection];
  try {
    if (!apply) throw new Error(`No applier for ${entry.target_collection}`);
    await apply(entry);
  } catch (error) {
    return (await callRpc("fail_outbox_entry", {
      p_entry_id: entry.entry_id,
      p_error: describeFailure(error),
      p_max_attempts: maxAttempts,
    })) || OUTBOX_STATE.PENDING;
  }
  await callRpc("complete_outbox_entry", { p_entry_id: entry.entry_id });
  return OUTBOX_STATE.APPLIED;
};

// The request handler's one attempt right after commit (Master 7.3 step 2).
// Returns null when the job already holds the entry.
const applyEntryNow = async (entryId) => {
  if (!entryId) return null;
  const claimed = await callRpc("claim_outbox_entry", { p_entry_id: entryId, p_lease_seconds: OUTBOX.LEASE_SECONDS });
  if (!claimed || !claimed.length) return null;
  return applyEntry(claimed[0]);
};

// One batch for the sync job. Returns how many entries were claimed.
const processDueEntries = async (limit = OUTBOX.BATCH_SIZE, maxAttempts = OUTBOX.MAX_ATTEMPTS) => {
  const claimed = await callRpc("claim_outbox_entries", { p_limit: limit, p_lease_seconds: OUTBOX.LEASE_SECONDS });
  const entries = claimed || [];
  for (const entry of entries) {
    await applyEntry(entry, maxAttempts);
  }
  return entries.length;
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

module.exports = { applyEntry, applyEntryNow, processDueEntries, findUnappliedDocuments };
