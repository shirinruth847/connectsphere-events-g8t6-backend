jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn() }));

const supabase = require("../../config/supabase");
const eventModel = require("../../model/eventModel");

// Characterizes how the event responses read venue preferences and equipment
// requirements (SPM-182 refactor). The three mappers must keep these outputs.
const unsortedPreferences = [
  { venue_id: 8, preference_order: 3 },
  { venue_id: 3, preference_order: 1 },
  { venue_id: 5, preference_order: 2 },
];
const equipmentRows = [
  { equipment_id: 4, quantity_requested: 2 },
  { equipment_id: 9, quantity_requested: 1, quantity: 7 },
];
// Rows without an embedded equipment row (RPC write results) carry no name or category.
const line = (equipmentId, quantity) => ({ equipmentId, name: null, category: null, quantity });

const availabilityFor = async (eventRow) => {
  const users = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue({ data: [{ user_id: 7, name: "Spm182 Coordinator" }], error: null }),
  };
  const events = {
    select: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue({ data: [{ coordinator_id: 7, event_id: 182, status: "PLANNING", ...eventRow }], error: null }),
  };
  supabase.from.mockImplementation((table) => (table === "user" ? users : events));
  const [coordinator] = await eventModel.findCoordinatorAvailability();
  return coordinator.events[0];
};

afterEach(() => jest.clearAllMocks());

describe("[SPM-182] venue preference and equipment mapping", () => {
  test("toApi_sorts_preferences_by_order_and_prefers_quantity_requested", () => {
    const result = eventModel.toApi({ event_id: 1, event_venue_preference: unsortedPreferences, event_equipment_requirement: equipmentRows });

    expect(result.venuePreferences).toEqual([3, 5, 8]);
    expect(result.equipmentRequirements).toEqual([line(4, 2), line(9, 1)]);
  });

  test("toApi_accepts_numeric_preferences_and_the_quantity_fallback", () => {
    const result = eventModel.toApi({
      event_id: 1,
      venue_preferences: [12, 4],
      event_venue_preference: unsortedPreferences,
      equipment_requirements: [{ equipment_id: 6, quantity: 3 }],
    });

    expect(result.venuePreferences).toEqual([12, 4]);
    expect(result.equipmentRequirements).toEqual([line(6, 3)]);
  });

  test("toApi_returns_empty_lists_for_missing_or_non_array_values", () => {
    const result = eventModel.toApi({ event_id: 1, event_venue_preference: null, event_equipment_requirement: "none" });

    expect(result.venuePreferences).toEqual([]);
    expect(result.equipmentRequirements).toEqual([]);
  });

  test("toApi_does_not_reorder_the_source_rows", () => {
    const rows = unsortedPreferences.map((row) => ({ ...row }));
    eventModel.toApi({ event_id: 1, event_venue_preference: rows });

    expect(rows.map((row) => row.venue_id)).toEqual([8, 3, 5]);
  });

  test("toUnassignedQueueItem_sorts_preferences_and_maps_equipment", () => {
    const result = eventModel.toUnassignedQueueItem({
      event_id: 2, status: "SUBMITTED", event_venue_preference: unsortedPreferences, event_equipment_requirement: equipmentRows,
    });

    expect(result.venuePreferences).toEqual([3, 5, 8]);
    expect(result.equipmentRequirements).toEqual([line(4, 2), line(9, 1)]);
  });

  test("toUnassignedQueueItem_returns_empty_lists_when_relations_are_missing", () => {
    const result = eventModel.toUnassignedQueueItem({ event_id: 2, status: "SUBMITTED" });

    expect(result.venuePreferences).toEqual([]);
    expect(result.equipmentRequirements).toEqual([]);
  });

  test("availability_events_sort_preferences_and_map_equipment", async () => {
    const event = await availabilityFor({ event_venue_preference: unsortedPreferences, event_equipment_requirement: equipmentRows });

    expect(event.venuePreferences).toEqual([3, 5, 8]);
    expect(event.equipmentRequirements).toEqual([line(4, 2), line(9, 1)]);
    expect(event.coordinatorName).toBe("Spm182 Coordinator");
  });

  test("availability_events_accept_numeric_preferences_and_the_quantity_fallback", async () => {
    const event = await availabilityFor({ event_venue_preference: [12, 4], event_equipment_requirement: [{ equipment_id: 6, quantity: 3 }] });

    expect(event.venuePreferences).toEqual([12, 4]);
    expect(event.equipmentRequirements).toEqual([line(6, 3)]);
  });

  test("availability_events_return_empty_lists_when_relations_are_missing", async () => {
    const event = await availabilityFor({});

    expect(event.venuePreferences).toEqual([]);
    expect(event.equipmentRequirements).toEqual([]);
  });
});

describe("[SPM-286] equipment requirement names", () => {
  test("toApi_names_each_requirement_from_the_embedded_equipment_row", () => {
    const result = eventModel.toApi({
      event_id: 1,
      event_equipment_requirement: [
        { equipment_id: 42, quantity_requested: 4, equipment: { name: "Wireless Mic", category: "Audio" } },
        { equipment_id: 9, quantity_requested: 1, equipment: null },
      ],
    });

    expect(result.equipmentRequirements).toEqual([
      { equipmentId: 42, name: "Wireless Mic", category: "Audio", quantity: 4 },
      line(9, 1),
    ]);
  });
});
