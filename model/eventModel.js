// All database access for the event table, plus conversion between
// API field names (camelCase) and database column names (snake_case).
const supabase = require('../config/supabase');
const { NO_LAYOUT_PREFERENCE, STATUS_LABELS } = require('../config/eventConstants');

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
const EVENT_SELECT = '*,organisation(organisation_id,name),event_venue_preference(venue_id,preference_order),event_equipment_requirement(equipment_id,quantity_requested)';
const INPUT_FIELDS = new Set([...Object.keys(FIELD_MAP), 'venuePreferences', 'equipmentRequirements']);

function getUnsupportedInputFields(body = {}, { allowAutoSave = false } = {}) {
  return Object.keys(body).filter(
    (key) => !INPUT_FIELDS.has(key) && !(allowAutoSave && key === 'isAutoSave')
  );
}

function pickEventInput(body = {}) {
  const input = {};
  for (const key of Object.keys(FIELD_MAP)) {
    if (body[key] !== undefined) input[key] = body[key];
  }
  for (const key of ['venuePreferences', 'equipmentRequirements']) {
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

function toApi(row, viewerUserId) {
  const venuePreferences = row.venue_preferences || row.event_venue_preference;
  const equipmentRequirements = row.equipment_requirements || row.event_equipment_requirement;
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
    venuePreferences: Array.isArray(venuePreferences)
      ? venuePreferences
          .slice()
          .sort((left, right) => (left.preference_order || 0) - (right.preference_order || 0))
          .map((item) => (typeof item === 'number' ? item : item.venue_id))
      : [],
    equipmentRequirements: Array.isArray(equipmentRequirements)
      ? equipmentRequirements.map((item) => ({
          equipmentId: item.equipment_id,
          quantity: item.quantity_requested ?? item.quantity,
        }))
      : [],
    isRegistrationEnabled: row.is_registration_enabled,
    registrationCapacity: row.registration_capacity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(viewerUserId === undefined ? {} : { is_owner: row.organiser_id === viewerUserId }),
    ...(row.organisation ? { organisation: row.organisation } : {}),
  };
}

function toRequirementPayload(input) {
  return {
    venuePreferences: input.venuePreferences,
    equipmentRequirements: Array.isArray(input.equipmentRequirements)
      ? input.equipmentRequirements.map(({ equipmentId, quantity }) => ({
          equipment_id: Number(equipmentId),
          quantity: Number(quantity),
        }))
      : input.equipmentRequirements,
  };
}

function unpackRpcEvent(data) {
  if (!data || !data.event) throw new Error('Event operation returned no event.');
  return {
    ...data.event,
    venue_preferences: data.venue_preferences || [],
    equipment_requirements: data.equipment_requirements || [],
  };
}

function eventRpcError(error) {
  const messages = {
    EVENT_NOT_FOUND: [404, 'Event request not found.'],
    EVENT_NOT_DRAFT: [409, 'Only draft requests can be changed or submitted.'],
    NO_ELIGIBLE_COORDINATOR: [409, 'No coordinator is currently available. Your request was not submitted.'],
    INVALID_EVENT_SUBMISSION: [400, 'Please fix the highlighted fields.'],
    DRAFT_TITLE_REQUIRED: [400, 'Event Title is required.'],
  };
  const mapped = messages[error.message];
  if (!mapped) throw error;
  const mappedError = new Error(mapped[1]);
  mappedError.statusCode = mapped[0];
  mappedError.publicMessage = mapped[1];
  throw mappedError;
}

async function saveDraft({ organiserId, eventId = null, input, isAutoSave = false }) {
  const requirements = toRequirementPayload(input);
  const { data, error } = await supabase.rpc('save_event_draft', {
    p_organiser_id: organiserId,
    p_event_id: eventId,
    p_event: toRow(input),
    p_venue_preferences: requirements.venuePreferences ?? null,
    p_equipment_requirements: requirements.equipmentRequirements ?? null,
    p_is_auto_save: isAutoSave,
  });
  if (error) eventRpcError(error);
  return unpackRpcEvent(data);
}

async function submitEvent({ organiserId, eventId = null, input }) {
  const requirements = toRequirementPayload(input);
  const { data, error } = await supabase.rpc('submit_event_request', {
    p_organiser_id: organiserId,
    p_event_id: eventId,
    p_event: toRow(input),
    p_venue_preferences: requirements.venuePreferences ?? null,
    p_equipment_requirements: requirements.equipmentRequirements ?? null,
  });
  if (error) eventRpcError(error);
  return unpackRpcEvent(data);
}

function getOrganiserVisibilityFilter(user) {
  const ownRequests = `organiser_id.eq.${Number(user.user_id)}`;
  const organisationIds = Array.isArray(user.organisation_ids)
    ? user.organisation_ids.map(Number).filter(Number.isSafeInteger)
    : [];
  if (organisationIds.length === 0) return ownRequests;
  return `${ownRequests},and(organisation_id.in.(${organisationIds.join(',')}),status.neq.DRAFT)`;
}

async function findEventById(eventId, user) {
  const { data, error } = await supabase
    .from('event')
    .select(EVENT_SELECT)
    .eq('event_id', eventId)
    .or(getOrganiserVisibilityFilter(user))
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function findEventsByOrganiser(user, status, limit, cursor, offset = 0) {
  let query = supabase
    .from('event')
    .select(EVENT_SELECT)
    .or(getOrganiserVisibilityFilter(user));
  if (status) query = query.eq('status', status);
  if (cursor) {
    query = query.or(
      `updated_at.lt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},event_id.lt.${cursor.eventId})`
    );
  }
  query = query
    .order('updated_at', { ascending: false })
    .order('event_id', { ascending: false });
  query = cursor ? query.limit(limit + 1) : query.range(offset, offset + limit);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function findOrganiserEventRequests(user, { limit, offset }, status) {
  let query = supabase
    .from('event')
    .select('event_id,title,status,start_datetime,end_datetime,expected_attendance,organiser_id,updated_at,created_at,organisation(organisation_id,name)')
    .or(getOrganiserVisibilityFilter(user))
    .order('updated_at', { ascending: false })
    .order('event_id', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query.range(offset, offset + limit);
  if (error) throw error;

  const events = data.slice(0, limit).map(({ organiser_id, ...event }) => ({
    ...event,
    is_owner: organiser_id === user.user_id,
  }));
  const hasMore = data.length > limit;
  return {
    events,
    nextOffset: hasMore ? offset + limit : null,
    nextCursor: hasMore ? encodeCursor(data[limit - 1]) : null,
  };
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const updatedAt = new Date(decoded.updatedAt);
    if (
      !Number.isInteger(decoded.eventId) ||
      decoded.eventId < 1 ||
      Number.isNaN(updatedAt.getTime()) ||
      updatedAt.toISOString() !== decoded.updatedAt
    ) {
      throw new Error('Invalid cursor');
    }
    return { updatedAt: decoded.updatedAt, eventId: decoded.eventId };
  } catch {
    const error = new Error('Invalid event cursor.');
    error.statusCode = 400;
    error.publicMessage = 'Invalid event cursor.';
    throw error;
  }
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at, eventId: row.event_id })).toString('base64url');
}

// Allowed layout options come from the rooms that actually exist, plus "no preference".
async function getAllowedLayouts() {
  const { data, error } = await supabase.from('room').select('layout_type');
  if (error) throw error;
  return [NO_LAYOUT_PREFERENCE, ...new Set(data.map((room) => room.layout_type))];
}

async function getAllowedRequirementIds() {
  const [venues, equipment] = await Promise.all([
    supabase.from('venue').select('venue_id'),
    supabase.from('equipment').select('equipment_id'),
  ]);
  if (venues.error) throw venues.error;
  if (equipment.error) throw equipment.error;
  return {
    venueIds: venues.data.map(({ venue_id }) => venue_id),
    equipmentIds: equipment.data.map(({ equipment_id }) => equipment_id),
  };
}

module.exports = {
  pickEventInput,
  getUnsupportedInputFields,
  toRow,
  toApi,
  formatRequestId,
  saveDraft,
  submitEvent,
  findEventById,
  findEventsByOrganiser,
  findOrganiserEventRequests,
  getOrganiserVisibilityFilter,
  buildOrganiserVisibilityFilter: getOrganiserVisibilityFilter,
  decodeCursor,
  encodeCursor,
  getAllowedLayouts,
  getAllowedRequirementIds,
};
