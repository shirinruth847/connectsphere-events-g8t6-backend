// Reads of the append-only change history (activity_log). Entries are written
// inside the database functions that make each change, never from here.
const supabase = require("../config/supabase");
const { parseAccessibility, eventRequestError } = require("./eventModel");

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

const toHistoryEntry = (row) => ({
  historyId: row.log_id,
  action: row.action,
  actor: { userId: row.user_id, name: toActorName(row), role: row.actor_role },
  occurredAt: row.timestamp,
  summary: row.details,
  changes: toChangeList(row.changes),
  audience: row.audience,
});

// Newest first. "audiences" lists what this reader may see (getEventAccess decides).
// The filter is part of the query, so entries for another audience (staff-only
// assignment records, or the owner's draft history) never leave the database for
// someone who may not read them (SPM-33 AC8). No audience means no entries.
const findEventHistory = async (eventId, { limit, cursor = null, audiences = [] }) => {
  const beforeLogId = decodeHistoryCursor(cursor);
  if (audiences.length === 0) return { history: [], nextCursor: null };

  let query = supabase
    .from("activity_log")
    .select(HISTORY_SELECT)
    .eq("entity_name", "event")
    .eq("entity_id", eventId)
    .in("audience", audiences);
  if (beforeLogId) query = query.lt("log_id", beforeLogId);

  const { data, error } = await query.order("log_id", { ascending: false }).limit(limit + 1);
  if (error) throw new Error(`[Supabase Error] ${error.message}`);

  const page = data.slice(0, limit);
  return {
    history: page.map(toHistoryEntry),
    nextCursor: data.length > limit ? encodeHistoryCursor(page[page.length - 1]) : null,
  };
};

module.exports = {
  findEventHistory,
  toHistoryEntry,
  toChangeList,
  encodeHistoryCursor,
  decodeHistoryCursor,
};
