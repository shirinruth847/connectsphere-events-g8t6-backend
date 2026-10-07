// All database access for the event table, plus conversion between
// API field names (camelCase) and database column names (snake_case).
const supabase = require('../config/supabase');
const { EVENT_STATUS, NO_LAYOUT_PREFERENCE, STATUS_LABELS } = require('../config/eventConstants');

// Whitelist: the ONLY fields a client may set. status, organiser_id, coordinator_id etc.
// are set by the server, so a user cannot send { status: 'CONFIRMED' } themselves.
const FIELD_MAP = Object.freeze({
  title: 'title',
  purpose: 'purpose',
  description: 'description',
  startDatetime: 'start_datetime',
  endDatetime: 'end_datetime',
  expectedAttendance: 'expected_attendance',
  preferredLayoutType: 'preferred_layout_type',
  accessibilityNeeds: 'accessibility_needs',
  isRegistrationEnabled: 'is_registration_enabled',
  registrationCapacity: 'registration_capacity',
});

const NUMERIC_FIELDS = ['expectedAttendance', 'registrationCapacity'];

function pickEventInput(body = {}) {
  const input = {};
  for (const key of Object.keys(FIELD_MAP)) {
    if (body[key] !== undefined) input[key] = body[key];
  }
  return input;
}

function toRow(input) {
  const row = {};
  for (const [key, column] of Object.entries(FIELD_MAP)) {
    if (input[key] === undefined) continue;
    let value = input[key];
    if (typeof value === 'string') value = value.trim();
    if (value === '') value = null;
    if (NUMERIC_FIELDS.includes(key) && value !== null) value = Number(value);
    // accessibility_needs is a text column; multi-select values are stored as a JSON string.
    if (key === 'accessibilityNeeds' && Array.isArray(value)) value = JSON.stringify(value);
    row[column] = value;
  }
  return row;
}

const formatRequestId = (eventId) => `REQ-${String(eventId).padStart(6, '0')}`;

function parseAccessibility(value) {
  if (typeof value !== 'string' || !value.startsWith('[')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toApi(row) {
  return {
    eventId: row.event_id,
    requestId: formatRequestId(row.event_id),
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    title: row.title,
    purpose: row.purpose,
    description: row.description,
    startDatetime: row.start_datetime,
    endDatetime: row.end_datetime,
    expectedAttendance: row.expected_attendance,
    preferredLayoutType: row.preferred_layout_type,
    accessibilityNeeds: parseAccessibility(row.accessibility_needs),
    isRegistrationEnabled: row.is_registration_enabled,
    registrationCapacity: row.registration_capacity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createEvent(row) {
  const { data, error } = await supabase.from('event').insert(row).select().single();
  if (error) throw error;
  return data;
}

async function updateEvent(eventId, patch) {
  const { data, error } = await supabase
    .from('event')
    .update(patch)
    .eq('event_id', eventId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function findEventById(eventId) {
  const { data, error } = await supabase
    .from('event')
    .select('*')
    .eq('event_id', eventId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function findEventsByOrganiser(organiserId, status) {
  let query = supabase
    .from('event')
    .select('*')
    .eq('organiser_id', organiserId)
    .order('updated_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function findUnassignedSubmittedEvents() {
  const { data, error } = await supabase
    .from('event')
    .select('*')
    .eq('status', EVENT_STATUS.SUBMITTED)
    .is('coordinator_id', null)
    .order('start_datetime', { ascending: true })
    .order('event_id', { ascending: true });
  if (error) throw error;
  return data;
}

// Allowed layout options come from the rooms that actually exist, plus "no preference".
async function getAllowedLayouts() {
  const { data, error } = await supabase.from('room').select('layout_type');
  if (error) throw error;
  return [NO_LAYOUT_PREFERENCE, ...new Set(data.map((room) => room.layout_type))];
}

module.exports = {
  pickEventInput,
  toRow,
  toApi,
  formatRequestId,
  createEvent,
  updateEvent,
  findEventById,
  findEventsByOrganiser,
  findUnassignedSubmittedEvents,
  getAllowedLayouts,
};