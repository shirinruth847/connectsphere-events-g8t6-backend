// Reads of the append-only change history (activity_log). Entries are written
// inside the database functions that make each change, never from here.
const supabase = require("../config/supabase");
const { parseAccessibility, eventRequestError } = require("./eventModel");
const { STATUS_LABELS } = require("../config/eventConstants");

const HISTORY_SELECT = "log_id,user_id,action,details,timestamp,actor_role,changes,audience,actor:user(name)";
const MAX_LOG_ID = 2147483647;

// Order in which changed fields are listed, whatever order the database stored them in.
const FIELD_ORDER = [
  "title",
  "purpose",
  "description",
  "startDatetime",
  "endDatetime",
  "expectedAttendance",
  "preferredLayoutType",
  "accessibilityNeeds",
  "venuePreferences",
  "equipmentRequirements",
  "technicalSupportNeeds",
  "isRegistrationEnabled",
  "registrationCapacity",
];

const encodeHistoryCursor = (row) => Buffer.from(JSON.stringify({ logId: row.log_id })).toString("base64url");

const decodeHistoryCursor = (value) => {
  if (value === undefined || value === null) return null;
  let decoded = null;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    decoded = null;
  }
  if (!decoded || !Number.isSafeInteger(decoded.logId) || decoded.logId < 1 || decoded.logId > MAX_LOG_ID) {
    throw eventRequestError("INVALID_CURSOR");
  }
  return decoded.logId;
};

// Stored values use database shapes; history shows them the way the event API does.
const toApiValue = (field, value) => {
  if (field === "accessibilityNeeds") return parseAccessibility(value) ?? null;
  if (field === "equipmentRequirements" && Array.isArray(value)) {
    return value.map((item) => ({ equipmentId: item.equipment_id, quantity: item.quantity }));
  }
  return value ?? null;
};

const toChangeList = (changes) => {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const position = (field) => (FIELD_ORDER.includes(field) ? FIELD_ORDER.indexOf(field) : FIELD_ORDER.length);
  return Object.keys(changes)
    .sort((left, right) => position(left) - position(right) || left.localeCompare(right))
    .map((field) => ({
      field,
      before: toApiValue(field, changes[field] ? changes[field].before : null),
      after: toApiValue(field, changes[field] ? changes[field].after : null),
    }));
};

// Entries written by background jobs have no user (SPM-173 AC4).
const SYSTEM_ACTOR_ROLE = "SYSTEM";

const toActorName = (row) => {
  if (row.actor_role === SYSTEM_ACTOR_ROLE) return "System";
  return row.actor ? row.actor.name : null;
};

const toHistoryEntry = (row, { organiserView = false } = {}) => ({
  historyId: row.log_id,
  action: row.action,
  actor: { userId: row.user_id, name: toActorName(row), role: row.actor_role },
  occurredAt: row.timestamp,
  summary: row.details,
  changes: toChangeList(row.changes).map((change) =>
    organiserView && change.field === "status"
      ? { ...change, beforeLabel: STATUS_LABELS[change.before] ?? "Unknown status", afterLabel: STATUS_LABELS[change.after] ?? "Unknown status" }
      : change),
  audience: row.audience,
});

// Only safety review entries and entries that changed one of "fields" (SPM-243 AC2).
const relevantHistoryFilter = (fields) =>
  ["action.like.SAFETY_*", ...fields.map((field) => `changes->${field}.not.is.null`)].join(",");

// Newest first. "audiences" lists what this reader may see (getEventAccess decides).
// The filter is part of the query, so entries for another audience (staff-only
// assignment records, or the owner's draft history) never leave the database for
// someone who may not read them (SPM-33 AC8). No audience means no entries.
// "fields", when given, narrows the history to the portion relevant to the reader.
const findEventHistory = async (eventId, { limit, cursor = null, audiences = [], fields = null, organiserView = false }) => {
  const beforeLogId = decodeHistoryCursor(cursor);
  if (audiences.length === 0) return { history: [], nextCursor: null };

  let query = supabase
    .from("activity_log")
    .select(HISTORY_SELECT)
    .eq("entity_name", "event")
    .eq("entity_id", eventId)
    .in("audience", audiences);
  if (fields) query = query.or(relevantHistoryFilter(fields));
  if (beforeLogId) query = query.lt("log_id", beforeLogId);

  const { data, error } = await query.order("log_id", { ascending: false }).limit(limit + 1);
  if (error) throw new Error(`[Supabase Error] ${error.message}`);

  const page = data.slice(0, limit);
  return {
    history: page.map((row) => toHistoryEntry(row, { organiserView })),
    nextCursor: data.length > limit ? encodeHistoryCursor(page[page.length - 1]) : null,
  };
};

// Appends an audit entry for a change committed outside PostgreSQL (a MongoDB
// detail edit, Master 7.4 step 3). The runtime may only insert (append-only).
const appendActivity = async ({ userId, entityName, entityId, action, details, changes = null, audience }) => {
  const { error } = await supabase.from("activity_log").insert({
    user_id: userId,
    entity_name: entityName,
    entity_id: entityId,
    action,
    details,
    changes,
    audience,
  });
  if (error) throw error;
};

// SPM-41 v2: when this person last viewed the event's history, or null, so the
// history can mark what is new to them (per person, unlike SPM-181's browser copy).
const findLastHistoryView = async (eventId, userId) => {
  const { data, error } = await supabase
    .from("event_history_views")
    .select("last_viewed_at")
    .eq("event_id", eventId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data ? data.last_viewed_at : null;
};

// Records that this person viewed the event's history now; returns the time.
// Callers check first that the viewer may see the event's history.
const markEventHistoryViewed = async (eventId, userId) => {
  const { data, error } = await supabase.rpc("mark_event_history_viewed", { p_event_id: eventId, p_actor_id: userId });
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data;
};

// Read only after event visibility has been checked. Never expose staff-only notes.
const findRejectionReason = async eventId => {
  const { data, error } = await supabase.from("activity_log").select("details")
    .eq("entity_name", "event").eq("entity_id", eventId)
    .eq("action", "EVENT_REJECTED").eq("audience", "ORGANISER_SAFE")
    .order("log_id", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`[Supabase Error] ${error.message}`);
  return data?.details ?? null;
};

module.exports = {
  appendActivity,
  findEventHistory,
  findRejectionReason,
  findLastHistoryView,
  markEventHistoryViewed,
  toHistoryEntry,
  toChangeList,
  encodeHistoryCursor,
  decodeHistoryCursor,
};
