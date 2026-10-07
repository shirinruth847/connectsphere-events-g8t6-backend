jest.mock('../config/supabase', () => ({
  from: jest.fn(),
  rpc: jest.fn(),
}));

const supabase = require('../config/supabase');
const eventModel = require('../model/eventModel');

beforeEach(() => jest.clearAllMocks());

test('submitEvent sends normalized fields and linked requirements to the atomic RPC', async () => {
  supabase.rpc.mockResolvedValue({
    data: {
      event: { event_id: 7, status: 'SUBMITTED' },
      venue_preferences: [2, 1],
      equipment_requirements: [{ equipment_id: 3, quantity: 4 }],
    },
    error: null,
  });

  const result = await eventModel.submitEvent({
    organiserId: 9,
    input: {
      title: 'Conference',
      venuePreferences: [2, 1],
      equipmentRequirements: [{ equipmentId: '3', quantity: '4' }],
    },
  });

  expect(supabase.rpc).toHaveBeenCalledWith('submit_event_request', {
    p_organiser_id: 9,
    p_event_id: null,
    p_event: { title: 'Conference' },
    p_venue_preferences: [2, 1],
    p_equipment_requirements: [{ equipment_id: 3, quantity: 4 }],
  });
  expect(result.event_id).toBe(7);
  expect(result.venue_preferences).toEqual([2, 1]);
  expect(result.equipment_requirements).toEqual([{ equipment_id: 3, quantity: 4 }]);
});

test('private event lookup always filters by both event and organiser IDs', async () => {
  const query = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    or: jest.fn(() => query),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
  supabase.from.mockReturnValue(query);

  await expect(
    eventModel.findEventById(42, { user_id: 17, organisation_ids: [] })
  ).resolves.toBeNull();

  expect(query.eq).toHaveBeenNthCalledWith(1, 'event_id', 42);
  expect(query.or).toHaveBeenCalledWith('organiser_id.eq.17');
});

test('organisation visibility excludes drafts from shared results', () => {
  expect(eventModel.getOrganiserVisibilityFilter({ user_id: 17, organisation_ids: [3, 9] })).toBe(
    'organiser_id.eq.17,and(organisation_id.in.(3,9),status.neq.DRAFT)'
  );
});

test('organiser event listing applies keyset cursor and a hard page bound', async () => {
  const query = {
    select: jest.fn(() => query),
    eq: jest.fn(() => query),
    or: jest.fn(() => query),
    order: jest.fn(() => query),
    limit: jest.fn().mockResolvedValue({ data: [], error: null }),
    range: jest.fn().mockResolvedValue({ data: [], error: null }),
  };
  supabase.from.mockReturnValue(query);

  await eventModel.findEventsByOrganiser(
    { user_id: 17, organisation_ids: [] },
    'DRAFT',
    20,
    { updatedAt: '2026-10-01T00:00:00.000Z', eventId: 12 }
  );

  expect(query.eq).toHaveBeenCalledWith('status', 'DRAFT');
  expect(query.or).toHaveBeenCalledWith(
    'updated_at.lt.2026-10-01T00:00:00.000Z,and(updated_at.eq.2026-10-01T00:00:00.000Z,event_id.lt.12)'
  );
  expect(query.order).toHaveBeenNthCalledWith(1, 'updated_at', { ascending: false });
  expect(query.order).toHaveBeenNthCalledWith(2, 'event_id', { ascending: false });
  expect(query.limit).toHaveBeenCalledWith(21);
});

test('cursor decoding rejects malformed or noncanonical values', () => {
  const cursor = eventModel.encodeCursor({ updated_at: '2026-10-01T00:00:00.000Z', event_id: 12 });
  expect(eventModel.decodeCursor(cursor)).toEqual({
    updatedAt: '2026-10-01T00:00:00.000Z',
    eventId: 12,
  });
  expect(() => eventModel.decodeCursor('not-a-cursor')).toThrow('Invalid event cursor.');
});