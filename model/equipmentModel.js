// Equipment catalogue maintenance by Technical Support (SPM-52). Every write is
// one PostgreSQL function that changes the item, writes its STAFF_ONLY activity
// entry and, when the MongoDB document changes, its outbox entry in one
// transaction (Master 7.1). Detail is applied to MongoDB after commit
// (Master 7.3); quantities and selection rules read PostgreSQL only.
const supabase = require("../config/supabase");
const outboxModel = require("./outboxModel");
const equipmentDetailModel = require("./equipmentDetailModel");
const { formatRequestId } = require("./eventModel");
const { MESSAGES } = require("../validators/equipmentValidator");
const {
  EQUIPMENT_STATUS,
  EQUIPMENT_STATUS_LABELS,
  DETAIL_STATUS,
  DETAILS_OUT_OF_DATE_NOTICE,
  UNAVAILABILITY_REASON_LABELS,
} = require("../config/equipmentConstants");

const EQUIPMENT_SELECT =
  "equipment_id,name,category,storage_location,total_quantity,is_active,details_pending,version,created_at,updated_at,created_by,updated_by";
const UNAVAILABILITY_SELECT =
  "unavailability_id,equipment_id,quantity,reason,starts_at,ends_at,note,status,version,created_at,updated_at,created_by,updated_by";
const DETAILS_COLLECTION = "equipment_details";
const MAX_UNAVAILABILITY_SHOWN = 100;

const equipmentError = (code, extra = {}) => Object.assign(new Error(code), { name: "EquipmentError", code, ...extra });

// Database failures that are the client's fault become EquipmentErrors; anything
// else is rethrown and answered with a safe 500.
const RPC_ERRORS = new Set([
  "FORBIDDEN",
  "EQUIPMENT_NOT_FOUND",
  "EQUIPMENT_VERSION_CONFLICT",
  "EQUIPMENT_NAME_TAKEN",
  "UNAVAILABILITY_NOT_FOUND",
  "UNAVAILABILITY_VERSION_CONFLICT",
  "UNAVAILABILITY_ENDED",
]);
const DETAILED_ERRORS = new Set(["EQUIPMENT_QUANTITY_COMMITTED", "EQUIPMENT_STOCK_EXCEEDED", "EQUIPMENT_HAS_UPCOMING_REQUESTS"]);
const FIELD_ERRORS = Object.freeze({
  UNAVAILABILITY_END_IN_PAST: { endsAt: MESSAGES.endInPast },
  INVALID_EQUIPMENT_CHANGES: {},
});
const CONSTRAINT_FIELDS = Object.freeze({
  equipment_total_quantity_nonnegative_check: { totalQuantity: MESSAGES.totalQuantityInvalid },
  equipment_name_not_blank_check: { name: MESSAGES.nameRequired },
  equipment_category_not_blank_check: { category: MESSAGES.categoryRequired },
  equipment_storage_location_check: { storageLocation: MESSAGES.storageLocationRequired },
  equipment_unavailability_period_check: { endsAt: MESSAGES.endBeforeStart },
  equipment_unavailability_quantity_check: { quantity: MESSAGES.quantityInvalid },
  equipment_unavailability_reason_check: { reason: MESSAGES.reasonInvalid },
  equipment_unavailability_note_check: { note: MESSAGES.noteRequired },
});

const readDetail = (error) => {
  try {
    return JSON.parse(error.details || "{}");
  } catch {
    return {};
  }
};

const toEquipmentError = (error) => {
  const message = error.message || "";
  const code = error.code || "";
  if (RPC_ERRORS.has(message)) return equipmentError(message);
  if (DETAILED_ERRORS.has(message)) return equipmentError(message, { detail: readDetail(error) });
  if (FIELD_ERRORS[message]) return equipmentError("VALIDATION_FAILED", { fields: FIELD_ERRORS[message] });
  const constraint = /constraint "([^"]+)"/.exec(message);
  if (constraint && CONSTRAINT_FIELDS[constraint[1]]) {
    return equipmentError("VALIDATION_FAILED", { fields: CONSTRAINT_FIELDS[constraint[1]] });
  }
  if (code.startsWith("22")) return equipmentError("VALIDATION_FAILED", { fields: {} });
  return error;
};

const callRpc = async (name, args) => {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw toEquipmentError(error);
  return data;
};

// ---------- read shapes ----------

const toPerson = (userId, names) => (userId ? { userId, name: names.get(userId) ?? null } : null);

const findUserNames = async (rows) => {
  const ids = [...new Set(rows.flatMap((row) => [row.created_by, row.updated_by]).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from("user").select("user_id,name").in("user_id", ids);
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return new Map(data.map((user) => [user.user_id, user.name]));
};

const toStatus = (row) => {
  if (!row.is_active) return EQUIPMENT_STATUS.INACTIVE;
  return row.details_pending ? EQUIPMENT_STATUS.DETAILS_PENDING : EQUIPMENT_STATUS.ACTIVE;
};

// unappliedState is "PENDING" or "FAILED" when the item's newest outbox entry
// has not reached MongoDB yet.
const toDetailStatus = (row, unappliedState) => {
  if (unappliedState === "FAILED") return DETAIL_STATUS.FAILED;
  if (row.details_pending) return DETAIL_STATUS.PENDING;
  return unappliedState ? DETAIL_STATUS.OUT_OF_DATE : DETAIL_STATUS.CURRENT;
};

const toEquipment = (row, { names = new Map(), unavailableNow = 0, unappliedState = null } = {}) => {
  const status = toStatus(row);
  const detailStatus = toDetailStatus(row, unappliedState);
  return {
    equipmentId: row.equipment_id,
    name: row.name,
    category: row.category,
    storageLocation: row.storage_location,
    totalQuantity: row.total_quantity,
    unavailableNow,
    isActive: row.is_active,
    status,
    statusLabel: EQUIPMENT_STATUS_LABELS[status],
    detailStatus,
    detailNotice: [DETAIL_STATUS.OUT_OF_DATE, DETAIL_STATUS.FAILED].includes(detailStatus) ? DETAILS_OUT_OF_DATE_NOTICE : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: toPerson(row.created_by, names),
    updatedBy: toPerson(row.updated_by, names),
  };
};

const toUnavailability = (row, names = new Map()) => ({
  unavailabilityId: row.unavailability_id,
  equipmentId: row.equipment_id,
  quantity: row.quantity,
  reason: row.reason,
  reasonLabel: UNAVAILABILITY_REASON_LABELS[row.reason] ?? row.reason,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  note: row.note,
  status: row.status,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdBy: toPerson(row.created_by, names),
  updatedBy: toPerson(row.updated_by, names),
});

// Units unavailable right now per item, from active records covering this instant.
const findUnavailableNow = async (equipmentIds) => {
  if (!equipmentIds.length) return new Map();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("equipment_unavailability")
    .select("equipment_id,quantity")
    .in("equipment_id", equipmentIds)
    .eq("status", "ACTIVE")
    .lte("starts_at", now)
    .gt("ends_at", now);
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  const totals = new Map();
  for (const row of data) totals.set(row.equipment_id, (totals.get(row.equipment_id) || 0) + row.quantity);
  return totals;
};

const toEquipmentList = async (rows) => {
  const ids = rows.map((row) => row.equipment_id);
  const [names, unavailable, unapplied] = await Promise.all([
    findUserNames(rows),
    findUnavailableNow(ids),
    outboxModel.findUnappliedDocuments(DETAILS_COLLECTION, ids),
  ]);
  return rows.map((row) => toEquipment(row, {
    names,
    unavailableNow: unavailable.get(row.equipment_id) || 0,
    unappliedState: unapplied.get(String(row.equipment_id)) || null,
  }));
};

// LIKE treats % and _ as wildcards; escape them so a search matches literally.
const escapeLike = (text) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

// ---------- reads ----------

// SPM-52 AC5: search by name and filter by category (both ignore letter case)
// and status, ordered by name.
const listEquipment = async ({ search, category, status }, { limit, offset }) => {
  let query = supabase.from("equipment").select(EQUIPMENT_SELECT);
  if (search) query = query.ilike("name", `%${escapeLike(search)}%`);
  if (category) query = query.ilike("category", escapeLike(category));
  if (status === EQUIPMENT_STATUS.INACTIVE) query = query.eq("is_active", false);
  if (status === EQUIPMENT_STATUS.ACTIVE) query = query.eq("is_active", true).eq("details_pending", false);
  if (status === EQUIPMENT_STATUS.DETAILS_PENDING) query = query.eq("is_active", true).eq("details_pending", true);

  // One extra row tells whether another page exists.
  const { data, error } = await query
    .order("name", { ascending: true })
    .order("equipment_id", { ascending: true })
    .range(offset, offset + limit);
  if (error) throw new Error(`[Supabase Error] ${error.message}`);

  const rows = data.slice(0, limit);
  return {
    equipment: await toEquipmentList(rows),
    nextOffset: data.length > limit ? offset + limit : null,
  };
};

// Categories in use, for the filter. Read on demand, so a new or renamed
// category appears in the next read.
const listEquipmentCategories = async () => {
  const { data, error } = await supabase.from("equipment").select("category");
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  const byKey = new Map();
  for (const { category } of data) {
    const key = category.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, category);
  }
  return { categories: [...byKey.values()].sort((a, b) => a.localeCompare(b)) };
};

const findEquipmentRow = async (equipmentId) => {
  const { data, error } = await supabase.from("equipment").select(EQUIPMENT_SELECT).eq("equipment_id", equipmentId).maybeSingle();
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data;
};

const findEquipmentSummary = async (equipmentId) => {
  const row = await findEquipmentRow(equipmentId);
  if (!row) return null;
  const [equipment] = await toEquipmentList([row]);
  return equipment;
};

// Current and upcoming unavailable stock; ended and cancelled records are in
// the activity history.
const findOpenUnavailability = async (equipmentId) => {
  const { data, error } = await supabase
    .from("equipment_unavailability")
    .select(UNAVAILABILITY_SELECT)
    .eq("equipment_id", equipmentId)
    .eq("status", "ACTIVE")
    .gt("ends_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .order("unavailability_id", { ascending: true })
    .limit(MAX_UNAVAILABILITY_SHOWN);
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data;
};

const findUnavailabilityRow = async (equipmentId, unavailabilityId) => {
  const { data, error } = await supabase
    .from("equipment_unavailability")
    .select(UNAVAILABILITY_SELECT)
    .eq("equipment_id", equipmentId)
    .eq("unavailability_id", unavailabilityId)
    .maybeSingle();
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data;
};

// The MongoDB document's display fields, or null when there is none. Throws
// when MongoDB cannot be read; the caller reports the details as not checked.
const toDetails = (document) => (document ? {
  specifications: document.specifications ?? null,
  technicalNotes: document.technicalNotes ?? null,
  handlingNotes: document.handlingNotes ?? null,
  pgVersion: document.pg_version,
  updatedAt: document.updatedAt ?? null,
} : null);

// SPM-52: the item, its MongoDB detail and its open unavailable stock. When
// MongoDB is unavailable the PostgreSQL data still loads and the details are
// reported as not checked (Master 7.3).
const getEquipment = async (equipmentId) => {
  const row = await findEquipmentRow(equipmentId);
  if (!row) return null;
  const records = await findOpenUnavailability(equipmentId);
  const [[equipment], names] = await Promise.all([toEquipmentList([row]), findUserNames(records)]);

  let details = null;
  let detailsRead = "OK";
  try {
    details = toDetails(await equipmentDetailModel.getEquipmentDetail(equipmentId));
  } catch (error) {
    console.error("[equipment] details could not be read", { equipmentId, message: String(error.message || "").slice(0, 200) });
    detailsRead = "NOT_CHECKED";
  }
  if (detailsRead === "OK" && !details && equipment.detailStatus === DETAIL_STATUS.CURRENT) {
    equipment.detailStatus = DETAIL_STATUS.NONE;
  }

  return {
    equipment,
    details,
    detailsRead,
    unavailability: records.map((record) => toUnavailability(record, names)),
  };
};

// ---------- writes ----------

// The post-commit attempt never changes the outcome of the request: the
// PostgreSQL change stands and the sync job retries (Master 7.3).
const applyDetailNow = async (entryId) => {
  try {
    await outboxModel.applyEntryNow(entryId);
  } catch (error) {
    console.error("[equipment] detail apply after commit failed", { entryId, message: String(error.message || "").slice(0, 200) });
  }
};

const afterWrite = async (data) => {
  if (data.entry_id) await applyDetailNow(data.entry_id);
  return findEquipmentSummary(data.equipment.equipment_id);
};

const createEquipment = async (actorId, values) => {
  const data = await callRpc("create_equipment", { p_actor_id: actorId, p_equipment: values });
  return { equipment: await afterWrite(data) };
};

const updateEquipment = async (actorId, equipmentId, version, changes) => {
  const data = await callRpc("update_equipment", {
    p_actor_id: actorId,
    p_equipment_id: equipmentId,
    p_expected_version: version,
    p_changes: changes,
  });
  return { equipment: await afterWrite(data), changed: data.changed === true };
};

const toUpcomingEvent = (item) => ({
  eventId: item.eventId,
  requestId: formatRequestId(item.eventId),
  title: item.title,
  startDatetime: item.startDatetime,
});

const setEquipmentActive = async (actorId, equipmentId, { active, version, confirmUpcomingRequests }) => {
  try {
    const data = await callRpc("set_equipment_active", {
      p_actor_id: actorId,
      p_equipment_id: equipmentId,
      p_expected_version: version,
      p_active: active,
      p_confirm_upcoming: confirmUpcomingRequests,
    });
    return {
      equipment: await findEquipmentSummary(equipmentId),
      changed: data.changed === true,
      upcomingRequests: data.upcoming_requests ?? 0,
    };
  } catch (error) {
    if (error.name === "EquipmentError" && error.code === "EQUIPMENT_HAS_UPCOMING_REQUESTS") {
      error.detail = {
        upcomingCount: error.detail.upcomingCount ?? 0,
        upcomingEvents: (error.detail.upcomingEvents || []).map(toUpcomingEvent),
      };
    }
    throw error;
  }
};

const afterUnavailabilityWrite = async (equipmentId, data) => {
  const [equipment, names] = await Promise.all([findEquipmentSummary(equipmentId), findUserNames([data.unavailability])]);
  return {
    unavailability: toUnavailability(data.unavailability, names),
    equipment,
    changed: data.changed === true,
  };
};

const recordUnavailability = async (actorId, equipmentId, values) => {
  const data = await callRpc("record_equipment_unavailability", {
    p_actor_id: actorId,
    p_equipment_id: equipmentId,
    p_record: values,
  });
  return afterUnavailabilityWrite(equipmentId, data);
};

const updateUnavailability = async (actorId, equipmentId, unavailabilityId, version, changes) => {
  const data = await callRpc("update_equipment_unavailability", {
    p_actor_id: actorId,
    p_equipment_id: equipmentId,
    p_unavailability_id: unavailabilityId,
    p_expected_version: version,
    p_changes: changes,
  });
  return afterUnavailabilityWrite(equipmentId, data);
};

const endUnavailability = async (actorId, equipmentId, unavailabilityId, version) => {
  const data = await callRpc("end_equipment_unavailability", {
    p_actor_id: actorId,
    p_equipment_id: equipmentId,
    p_unavailability_id: unavailabilityId,
    p_expected_version: version,
  });
  return afterUnavailabilityWrite(equipmentId, data);
};

module.exports = {
  listEquipment,
  listEquipmentCategories,
  getEquipment,
  findEquipmentSummary,
  findUnavailabilityRow,
  createEquipment,
  updateEquipment,
  setEquipmentActive,
  recordUnavailability,
  updateUnavailability,
  endUnavailability,
  toEquipmentError,
  toStatus,
  toDetailStatus,
};
