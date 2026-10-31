jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../config/mongodb", () => ({ getMongoDb: jest.fn() }));

const supabase = require("../../config/supabase");
const { venueRequirements, toOptionAvailability, compareOptions, suggestEventVenue } = require("../../model/venueModel");

const venue = (overrides = {}) => ({
  venueId: 1,
  name: "Grand Hall",
  maxCapacity: 300,
  rooms: [],
  supportedLayouts: ["Theater", "Banquet"],
  accessibilityFeatures: ["Wheelchair accessible entrance", "Hearing loop"],
  facilities: ["Projector", "Stage lighting"],
  ...overrides,
});
const event = (overrides = {}) => ({
  expected_attendance: 150,
  preferred_layout_type: "THEATRE",
  accessibility_needs: JSON.stringify(["Wheelchair / barrier-free access"]),
  ...overrides,
});
const available = { requirementStatus: "MET", detail: "Free" };
const statuses = (list) => Object.fromEntries(list.map((item) => [item.key, item.status]));

describe("venueRequirements (SPM-72 AC5)", () => {
  test("should_not_mark_unrelated_facilities_or_accessibility_as_met_from_shared_words", () => {
    const list = venueRequirements({
      venue: venue({ facilities: ["Fire alarm system"], accessibilityFeatures: ["Hearing protection available"] }),
      event: event({ accessibility_needs: JSON.stringify(["Assistive listening system / hearing loop"]) }),
      requiredFacilities: ["PA system"],
      availability: available,
      detailsRead: true,
    });
    expect(statuses(list)["facility-0"]).toBe("UNMET");
    expect(statuses(list)["accessibility-0"]).toBe("UNMET");
  });

  test("should_match_complete_labels_ignoring_case_and_punctuation", () => {
    const list = venueRequirements({
      venue: venue({ facilities: ["PA-system"], accessibilityFeatures: ["HEARING LOOP"] }),
      event: event({ accessibility_needs: JSON.stringify(["Hearing loop"]) }),
      requiredFacilities: ["pa system"],
      availability: available,
      detailsRead: true,
    });
    expect(statuses(list)["facility-0"]).toBe("MET");
    expect(statuses(list)["accessibility-0"]).toBe("MET");
  });

  test("[SPM-200-TC3] should_match_the_form's_canonical_needs_to_recorded_capabilities", () => {
    const list = venueRequirements({
      venue: venue(),
      event: event({ accessibility_needs: JSON.stringify([
        "Wheelchair / barrier-free access", "Assistive listening system / hearing loop", "Live CART / ASL captioning space",
      ]) }),
      requiredFacilities: [], availability: available, detailsRead: true,
    });
    expect(list.filter((need) => need.key.startsWith("accessibility-")).map((need) => need.status))
      .toEqual(["MET", "MET", "UNMET"]);
  });

  test("[SPM-200-AC6][Master M4] should_not_treat_legacy_fallbacks_as_verified_during_an_outage", () => {
    const list = venueRequirements({
      venue: venue({ rooms: [{ layoutType: "THEATRE" }], supportedLayouts: null, facilities: null }),
      event: event(), requiredFacilities: ["Projector"],
      availability: { requirementStatus: "NOT_CHECKED", detail: "Unknown" }, detailsRead: false,
    });
    expect(statuses(list)).toEqual({ capacity: "MET", availability: "NOT_CHECKED", layout: "NOT_CHECKED", "accessibility-0": "NOT_CHECKED", "facility-0": "NOT_CHECKED" });
  });

  test("[SPM-72-AC5] should_mark_every_stated_requirement_met", () => {
    const list = venueRequirements({ venue: venue(), event: event(), requiredFacilities: ["projector"], availability: available, detailsRead: true });

    expect(statuses(list)).toEqual({ capacity: "MET", availability: "MET", layout: "MET", "accessibility-0": "MET", "facility-0": "MET" });
  });

  test("[SPM-72-AC5] should_mark_unmet_requirements", () => {
    const list = venueRequirements({
      venue: venue({ maxCapacity: 100, supportedLayouts: ["Banquet"], accessibilityFeatures: [], facilities: [] }),
      event: event(),
      requiredFacilities: ["Projector"],
      availability: { requirementStatus: "UNMET", detail: "Booked" },
      detailsRead: true,
    });

    expect(statuses(list)).toEqual({ capacity: "UNMET", availability: "UNMET", layout: "UNMET", "accessibility-0": "UNMET", "facility-0": "UNMET" });
  });

  test("[SPM-72-AC5] should_treat_capacity_equal_to_attendance_as_met", () => {
    const list = venueRequirements({ venue: venue({ maxCapacity: 150 }), event: event(), requiredFacilities: [], availability: available, detailsRead: true });
    expect(statuses(list).capacity).toBe("MET");
  });

  describe("capacity assessment (SPM-198)", () => {
    const capacityFor = (maxCapacity, expected = 150) => venueRequirements({
      venue: venue({ maxCapacity }), event: event({ expected_attendance: expected }), requiredFacilities: [], availability: available, detailsRead: true,
    }).find((item) => item.key === "capacity");

    test("[SPM-198-AC1] should_call_more_places_than_guests_sufficient", () => {
      expect(capacityFor(200)).toMatchObject({
        status: "MET",
        assessment: {
          level: "SUFFICIENT",
          title: "Capacity Sufficient",
          message: "Venue capacity is adequate (200 seats for 150 guests). Comfortable spacing available.",
        },
      });
    });

    test("[SPM-198-AC2] should_call_exactly_full_adequate_and_still_met", () => {
      expect(capacityFor(150)).toMatchObject({
        status: "MET",
        assessment: {
          level: "EXACT",
          title: "Capacity Adequate",
          message: "Venue exactly meets expected attendance (150 seats for 150 guests). No buffer space. May feel crowded.",
        },
      });
    });

    test("[SPM-198-AC3] should_call_fewer_places_than_guests_insufficient", () => {
      expect(capacityFor(100)).toMatchObject({
        status: "UNMET",
        assessment: {
          level: "INSUFFICIENT",
          title: "Capacity Insufficient",
          message: "Venue is too small (100 seats for 150 expected guests). Cannot accommodate. Recommend alternative venue.",
        },
      });
    });

    test("[SPM-198] should_apply_the_boundaries_one_either_side_and_group_thousands", () => {
      expect(capacityFor(151).assessment.level).toBe("SUFFICIENT");
      expect(capacityFor(149).assessment.level).toBe("INSUFFICIENT");
      expect(capacityFor(1500, 1200).assessment.message).toBe(
        "Venue capacity is adequate (1,500 seats for 1,200 guests). Comfortable spacing available."
      );
    });

    test("[SPM-198] should_give_no_assessment_without_expected_attendance", () => {
      const list = venueRequirements({ venue: venue(), event: event({ expected_attendance: null }), requiredFacilities: [], availability: available, detailsRead: true });
      expect(list.find((item) => item.key === "capacity")).toBeUndefined();
    });
  });

  test("[SPM-72-AC6] should_report_details_not_checked_when_mongodb_is_unavailable", () => {
    const list = venueRequirements({
      venue: venue({ supportedLayouts: null, accessibilityFeatures: null, facilities: null, rooms: [{ layoutType: "Classroom" }] }),
      event: event(),
      requiredFacilities: ["Projector"],
      availability: { requirementStatus: "NOT_CHECKED", detail: "Unknown" },
      detailsRead: false,
    });

    expect(statuses(list)).toEqual({ capacity: "MET", availability: "NOT_CHECKED", layout: "NOT_CHECKED", "accessibility-0": "NOT_CHECKED", "facility-0": "NOT_CHECKED" });
  });

  test("[SPM-72-AC5] should_skip_requirements_the_event_does_not_state", () => {
    const list = venueRequirements({
      venue: venue(),
      event: event({ expected_attendance: null, preferred_layout_type: "NO_PREFERENCE", accessibility_needs: "None" }),
      requiredFacilities: [],
      availability: available,
      detailsRead: true,
    });

    expect(list.map((item) => item.key)).toEqual(["availability"]);
  });
});

describe("toOptionAvailability (SPM-72 AC6)", () => {
  const check = (overrides = {}) => ({
    availability: "AVAILABLE",
    availabilityLabel: "Available",
    canRequest: true,
    conflicts: [],
    occupiedStart: "2026-12-01T01:30:00.000Z",
    occupiedEnd: "2026-12-01T04:45:00.000Z",
    operatingHoursWarning: null,
    ...overrides,
  });

  test("[SPM-72-AC6] should_mark_a_free_venue_met_with_a_short_label", () => {
    const summary = toOptionAvailability({ buffersRecorded: true, entries: [], check: check() });

    expect(summary).toMatchObject({ status: "AVAILABLE", label: "Available", requirementStatus: "MET", detail: "Available" });
  });

  test("[SPM-72-AC6] should_list_the_overlapping_booking", () => {
    const summary = toOptionAvailability({
      buffersRecorded: true,
      entries: [{ entryId: "b1", label: "Booking REQ-000009" }],
      check: check({
        availability: "UNAVAILABLE_BOOKING",
        availabilityLabel: "Unavailable – booking",
        canRequest: false,
        conflicts: [{ type: "BOOKING", entryId: "b1", occupiedStart: "s", occupiedEnd: "e" }],
      }),
    });

    expect(summary).toMatchObject({ requirementStatus: "UNMET", detail: "Unavailable – booking" });
    expect(summary.conflicts).toEqual([expect.objectContaining({ type: "BOOKING", label: "Booking REQ-000009" })]);
  });

  test("[SPM-72-AC6] should_never_show_an_unchecked_venue_as_available", () => {
    expect(toOptionAvailability(null)).toMatchObject({ status: "NOT_CHECKED", label: "Error checking availability", requirementStatus: "NOT_CHECKED" });
  });

  test("[SPM-72-AC6] should_not_check_an_event_without_dates", () => {
    expect(toOptionAvailability(null, { hasDates: false })).toMatchObject({ status: "NO_DATES", label: "Enter the event date", requirementStatus: "NOT_CHECKED" });
  });
});

describe("compareOptions (SPM-72 AC5)", () => {
  const option = (name, unmetCount, extra = {}) => ({ venueId: name.length, name, unmetCount, maxCapacity: 100, setupMinutes: 30, ...extra });

  test("[SPM-72-AC5] should_put_venues_meeting_every_requirement_first_whatever_the_sort", () => {
    const list = [option("Alpha", 2, { maxCapacity: 900 }), option("Bravo", 0, { maxCapacity: 50 }), option("Charlie", 1)];

    expect(list.sort(compareOptions("capacity", "desc")).map((item) => item.name)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  test("[SPM-72-AC3] should_apply_the_chosen_sort_within_a_group", () => {
    const list = [option("Alpha", 0, { maxCapacity: 100 }), option("Bravo", 0, { maxCapacity: 500 }), option("Charlie", 0, { maxCapacity: 300 })];

    expect(list.sort(compareOptions("capacity", "desc")).map((item) => item.name)).toEqual(["Bravo", "Charlie", "Alpha"]);
    expect(list.sort(compareOptions("capacity", "asc")).map((item) => item.name)).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  test("[SPM-72-AC3] should_put_missing_setup_minutes_last", () => {
    const list = [option("Alpha", 0, { setupMinutes: null }), option("Bravo", 0, { setupMinutes: 45 }), option("Charlie", 0, { setupMinutes: 15 })];

    expect(list.sort(compareOptions("setup", "asc")).map((item) => item.name)).toEqual(["Charlie", "Bravo", "Alpha"]);
    expect(list.sort(compareOptions("setup", "desc")).map((item) => item.name)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });
});

describe("suggestEventVenue (SPM-72 AC8)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("[SPM-72-AC8] should_call_the_rpc_with_a_request_hash_scoped_to_event_and_version", async () => {
    supabase.rpc.mockResolvedValue({ data: { suggestion: { venueId: 7, version: 1 } }, error: null });

    await expect(suggestEventVenue({ actorId: 20, eventId: 42, venueId: 7, expectedVersion: 0, idempotencyKey: "key-12345" }))
      .resolves.toEqual({ venueId: 7, version: 1 });

    const [name, args] = supabase.rpc.mock.calls[0];
    expect(name).toBe("suggest_event_venue");
    expect(args).toEqual(expect.objectContaining({ p_actor_id: 20, p_event_id: 42, p_venue_id: 7, p_expected_version: 0, p_idempotency_key: "key-12345" }));
    expect(args.p_request_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("[SPM-72-AC10] should_turn_a_known_rpc_refusal_into_a_venue_error", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: "VENUE_CAPACITY_TOO_SMALL" } });

    await expect(suggestEventVenue({ actorId: 20, eventId: 42, venueId: 7, expectedVersion: 0, idempotencyKey: "key-12345" }))
      .rejects.toMatchObject({ name: "VenueError", code: "VENUE_CAPACITY_TOO_SMALL" });
  });

  test("should_rethrow_an_unknown_database_error", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });

    await expect(suggestEventVenue({ actorId: 20, eventId: 42, venueId: 7, expectedVersion: 0, idempotencyKey: "key-12345" }))
      .rejects.toMatchObject({ message: "connection reset" });
  });
});
