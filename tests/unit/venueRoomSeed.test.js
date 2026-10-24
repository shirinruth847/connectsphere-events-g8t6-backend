// The development halls and rooms (developer request of 24 October 2026) must
// fit the venue rules before anything is written. No network or database here.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));

const { BUILDINGS, FIXTURE, hallCapacity } = require("../../mongodb/seed/venueRoomSeed");
const schema = require("../../mongodb/schemas/venue_details.json").$jsonSchema.properties;

const venues = BUILDINGS.flatMap(({ hall, rooms }) => [hall, ...rooms]);

describe("venue room seed data", () => {
  test("[SPM-72] should_make_each_hall_hold_its_rooms_plus_its_common_area", () => {
    for (const building of BUILDINGS) {
      expect(building.rooms.length).toBeGreaterThanOrEqual(2);
      expect(building.hall.commonArea).toBeGreaterThan(0);
      expect(hallCapacity(building)).toBe(building.rooms.reduce((sum, room) => sum + room.capacity, 0) + building.hall.commonArea);
    }
    expect(hallCapacity(BUILDINGS[0])).toBe(600);
  });

  test("[SPM-72] should_give_every_venue_a_unique_seed_name_valid_hours_minutes_and_layouts", () => {
    const names = venues.map(({ name }) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    for (const venue of venues) {
      expect(venue.name).toMatch(/^\[seed:dev\] /);
      expect(venue.operatingHours).toMatch(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-4]):[0-5]\d$/);
      expect(Number.isInteger(venue.setupMinutes) && venue.setupMinutes >= 0).toBe(true);
      expect(Number.isInteger(venue.turnaroundMinutes) && venue.turnaroundMinutes >= 0).toBe(true);
      expect(venue.supportedLayouts.length).toBeGreaterThan(0);
      expect(venue.supportedLayouts.length).toBeLessThanOrEqual(schema.supportedLayouts.maxItems);
      expect(venue.photos.length).toBeGreaterThan(0);
      for (const entry of venue.photos) expect(entry).toHaveLength(3);
    }
  });

  test("[SPM-72] should_tag_documents_for_cleanup", () => {
    expect(FIXTURE).toBe("spm72-rooms");
  });
});
