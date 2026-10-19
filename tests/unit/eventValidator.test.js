const {
  validateDraft,
  validateSubmission,
  validateRequirements,
  MESSAGES,
} = require("../../validators/eventValidator");

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-01T09:00:00+08:00");
const LAYOUTS = ["NO_PREFERENCE", "THEATRE", "CLASSROOM"];
const inHours = (h) => new Date(NOW.getTime() + h * HOUR).toISOString();

// A fully valid submission 7 days ahead (SPM-35 TC-001 test data).
const validRequest = () => ({
  title: "Tech Conference 2026",
  purpose: "Annual industry conference",
  description: "Talks and networking for tech professionals.",
  startDatetime: inHours(7 * 24),
  endDatetime: inHours(7 * 24 + 8),
  expectedAttendance: 150,
  preferredLayoutType: "THEATRE",
  accessibilityNeeds: ["Wheelchair access"],
  isRegistrationEnabled: true,
  registrationCapacity: 150,
});

const submit = (input) => validateSubmission(input, { now: NOW, allowedLayouts: LAYOUTS });
const draft = (input) => validateDraft(input, { allowedLayouts: LAYOUTS });

describe("validateSubmission (SPM-35 Event Request Creation)", () => {
  test("[SPM-35-TC-001] should_accept_the_request_when_every_field_is_valid", () => {
    expect(submit(validRequest())).toEqual({});
  });

  test("[SPM-35-TC-002] should_return_the_exact_title_message_when_title_is_blank", () => {
    expect(submit({ ...validRequest(), title: "   " }).title).toBe("Event Title is required.");
  });

  test("[SPM-35-TC-003] should_block_the_request_when_start_is_24_hours_ahead", () => {
    const errors = submit({ ...validRequest(), startDatetime: inHours(24), endDatetime: inHours(26) });
    expect(errors.startDatetime).toBe("Event date must be at least 48 hours in advance.");
  });

  test("[SPM-35-TC-003] should_accept_the_request_when_start_is_exactly_48_hours_ahead", () => {
    const errors = submit({ ...validRequest(), startDatetime: inHours(48), endDatetime: inHours(50) });
    expect(errors.startDatetime).toBeUndefined();
  });

  test("[SPM-35-TC-003] should_block_the_request_when_start_is_one_minute_under_48_hours", () => {
    const start = new Date(NOW.getTime() + 48 * HOUR - 60 * 1000).toISOString();
    const errors = submit({ ...validRequest(), startDatetime: start, endDatetime: inHours(50) });
    expect(errors.startDatetime).toBe(MESSAGES.leadTime);
  });

  test("[SPM-35-AC2] should_report_each_mandatory_field_when_the_request_is_empty", () => {
    expect(Object.keys(submit({})).sort()).toEqual(
      ["description", "endDatetime", "expectedAttendance", "preferredLayoutType", "purpose", "startDatetime", "title"].sort()
    );
  });

  test("[SPM-35-AC2] should_block_the_request_when_end_is_before_start", () => {
    expect(submit({ ...validRequest(), endDatetime: inHours(7 * 24 - 1) }).endDatetime).toBe(MESSAGES.endBeforeStart);
  });

  test.each([0, -5, 12.5, "abc", "-5", "1e3", true, 2147483648])(
    "[SPM-35-AC2] should_reject_attendance_when_value_is_%p",
    (value) => {
      expect(submit({ ...validRequest(), expectedAttendance: value }).expectedAttendance).toBe(MESSAGES.attendanceInvalid);
    }
  );

  test.each(["150", " 150 ", 2147483647])("[SPM-35-AC2] should_accept_attendance_when_value_is_%p", (value) => {
    expect(submit({ ...validRequest(), expectedAttendance: value })).toEqual({});
  });

  test("[SPM-35-AC2] should_reject_the_layout_when_it_is_not_an_allowed_option", () => {
    expect(submit({ ...validRequest(), preferredLayoutType: "SPACESHIP" }).preferredLayoutType).toBe(MESSAGES.layoutInvalid);
  });

  test("[SPM-35-AC2] should_require_capacity_when_registration_is_enabled", () => {
    expect(submit({ ...validRequest(), registrationCapacity: null }).registrationCapacity).toBe(
      MESSAGES.registrationCapacityRequired
    );
  });

  test("[SPM-35-AC2] should_not_require_capacity_when_registration_is_disabled", () => {
    expect(submit({ ...validRequest(), isRegistrationEnabled: false, registrationCapacity: null })).toEqual({});
  });
});

describe("format checks shared by drafts and submissions", () => {
  test.each([
    ["no timezone offset", "2026-10-20T09:00:00"],
    ["epoch number", 1893456000000],
    ["date only", "2026-10-20"],
    ["impossible calendar day", "2026-02-30T09:00:00+08:00"],
    ["hour out of range", "2026-10-20T24:00:00Z"],
  ])("[EVT-VAL-001] should_reject_the_start_when_it_is_%s", (_label, value) => {
    expect(draft({ title: "Gala", startDatetime: value }).startDatetime).toBe(MESSAGES.invalidDate);
  });

  test.each([
    "2026-10-20T09:00+08:00",
    "2026-10-20T09:00:00Z",
    "2026-10-20T09:00:00.123456+00:00",
  ])("[EVT-VAL-001] should_accept_the_start_when_it_is_%s", (value) => {
    expect(draft({ title: "Gala", startDatetime: value })).toEqual({});
  });

  test("[EVT-VAL-002] should_reject_the_title_when_it_is_longer_than_the_database_column", () => {
    expect(draft({ title: "x".repeat(201) }).title).toBe(MESSAGES.titleTooLong);
    expect(draft({ title: "x".repeat(200) })).toEqual({});
  });

  test.each([
    ["purpose", 2001, MESSAGES.purposeTooLong],
    ["description", 5001, MESSAGES.descriptionTooLong],
  ])("[EVT-VAL-002] should_reject_%s_when_it_is_too_long", (field, length, message) => {
    expect(draft({ title: "Gala", [field]: "x".repeat(length) })[field]).toBe(message);
  });

  test.each([[123], [{ text: "Gala" }], [["Gala"]]])("[EVT-VAL-003] should_reject_the_title_when_it_is_%j", (title) => {
    expect(draft({ title }).title).toBe(MESSAGES.textInvalid);
  });

  test.each([
    [{ nested: { deep: true } }],
    [[1, 2]],
    [[""]],
    [Array.from({ length: 21 }, () => "Ramp")],
    [["x".repeat(201)]],
  ])("[EVT-VAL-004] should_reject_accessibility_needs_when_value_is_%j", (accessibilityNeeds) => {
    expect(draft({ title: "Gala", accessibilityNeeds }).accessibilityNeeds).toBe(MESSAGES.accessibilityInvalid);
  });

  test.each([[["Wheelchair access", "Hearing loop"]], ["Step-free entrance"], [null], [[]]])(
    "[EVT-VAL-004] should_accept_accessibility_needs_when_value_is_%j",
    (accessibilityNeeds) => {
      expect(draft({ title: "Gala", accessibilityNeeds })).toEqual({});
    }
  );
});

describe("validateDraft (SPM-37 Draft Event Requests)", () => {
  test("[SPM-37-S1] should_accept_the_draft_when_only_the_title_is_filled_in", () => {
    expect(draft({ title: "SMU Alumni Gala 2026" })).toEqual({});
  });

  test("[SPM-37-S1] should_require_the_title_when_saving_a_draft", () => {
    expect(draft({ description: "Some notes" }).title).toBe(MESSAGES.titleRequired);
  });

  test("[SPM-37-S1] should_accept_registration_without_capacity_when_saving_a_draft", () => {
    expect(draft({ title: "Gala", isRegistrationEnabled: true })).toEqual({});
  });

  test("[SPM-37-S1] should_reject_badly_formatted_values_when_saving_a_draft", () => {
    expect(draft({ title: "Gala", expectedAttendance: -10 }).expectedAttendance).toBe(MESSAGES.attendanceInvalid);
  });

  test("[SPM-37-S1] should_not_apply_the_48_hour_rule_when_saving_a_draft", () => {
    expect(draft({ title: "Gala", startDatetime: inHours(1), endDatetime: inHours(2) })).toEqual({});
  });

  test("[SPM-37-TC-NEG-INCOMPLETE] should_return_the_exact_attendance_message_when_submitting_without_attendance", () => {
    expect(submit({ ...validRequest(), expectedAttendance: "" }).expectedAttendance).toBe(
      "Expected Attendance is required for submission"
    );
  });
});

describe("validateRequirements (venue and equipment preferences)", () => {
  const allowed = { venueIds: [1, 2], equipmentIds: [3, 4] };

  test("[EVT-REQ-001] should_accept_ordered_venues_and_equipment_when_all_exist", () => {
    expect(
      validateRequirements({ venuePreferences: [2, 1], equipmentRequirements: [{ equipmentId: 3, quantity: 2 }] }, allowed)
    ).toEqual({});
  });

  test("[EVT-REQ-001] should_accept_numeric_strings_when_sent_from_select_controls", () => {
    expect(
      validateRequirements({ venuePreferences: ["2", "1"], equipmentRequirements: [{ equipmentId: "3", quantity: "2" }] }, allowed)
    ).toEqual({});
  });

  test.each([[[1, 1]], [[true]], [[1.5]], [["1x"]], [null], [Array.from({ length: 21 }, (_, i) => i + 1)]])(
    "[EVT-REQ-002] should_reject_venue_preferences_when_value_is_%j",
    (venuePreferences) => {
      const everyVenue = { venueIds: Array.from({ length: 30 }, (_, i) => i + 1) };
      expect(validateRequirements({ venuePreferences }, everyVenue).venuePreferences).toBe(MESSAGES.venuePreferencesInvalid);
    }
  );

  test("[EVT-REQ-002] should_reject_a_venue_that_does_not_exist", () => {
    expect(validateRequirements({ venuePreferences: [9] }, allowed).venuePreferences).toBe(MESSAGES.venuePreferencesInvalid);
  });

  test.each([
    [[{ equipmentId: 3, quantity: 0 }]],
    [[{ equipmentId: 3, quantity: 1 }, { equipmentId: 3, quantity: 2 }]],
    [[{ equipmentId: 9, quantity: 1 }]],
    [[{ equipmentId: 3, quantity: 1, price: 5 }]],
    [[{ equipmentId: 3, quantity: 2147483648 }]],
    [[null]],
  ])("[EVT-REQ-003] should_reject_equipment_requirements_when_value_is_%j", (equipmentRequirements) => {
    expect(validateRequirements({ equipmentRequirements }, allowed).equipmentRequirements).toBe(
      MESSAGES.equipmentRequirementsInvalid
    );
  });
});
