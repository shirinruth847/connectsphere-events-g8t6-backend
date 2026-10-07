const {
  validateDraft,
  validateSubmission,
  validateRequirements,
  MESSAGES,
} = require('../validators/eventValidator');

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-01T09:00:00+08:00');
const LAYOUTS = ['NO_PREFERENCE', 'THEATRE', 'CLASSROOM'];
const inHours = (h) => new Date(NOW.getTime() + h * HOUR).toISOString();

// A fully valid submission 7 days ahead (TC-001 test data).
const validRequest = () => ({
  title: 'Tech Conference 2026',
  purpose: 'Annual industry conference',
  description: 'Talks and networking for tech professionals.',
  startDatetime: inHours(7 * 24),
  endDatetime: inHours(7 * 24 + 8),
  expectedAttendance: 150,
  preferredLayoutType: 'THEATRE',
  accessibilityNeeds: ['Wheelchair access'],
  isRegistrationEnabled: true,
  registrationCapacity: 150,
});

const submit = (input) => validateSubmission(input, { now: NOW, allowedLayouts: LAYOUTS });

describe('validateSubmission (Event Request Creation)', () => {
  test('TC-001: all valid fields pass', () => {
    expect(submit(validRequest())).toEqual({});
  });

  test('TC-002: blank title is blocked with the exact message', () => {
    const errors = submit({ ...validRequest(), title: '   ' });
    expect(errors.title).toBe('Event Title is required.');
  });

  test('TC-003: start date 24 hours ahead is blocked', () => {
    const errors = submit({ ...validRequest(), startDatetime: inHours(24), endDatetime: inHours(26) });
    expect(errors.startDatetime).toBe('Event date must be at least 48 hours in advance.');
  });

  test('Boundary: exactly 48 hours ahead is allowed', () => {
    const errors = submit({ ...validRequest(), startDatetime: inHours(48), endDatetime: inHours(50) });
    expect(errors.startDatetime).toBeUndefined();
  });

  test('Boundary: 1 minute under 48 hours is blocked', () => {
    const start = new Date(NOW.getTime() + 48 * HOUR - 60 * 1000).toISOString();
    const errors = submit({ ...validRequest(), startDatetime: start, endDatetime: inHours(50) });
    expect(errors.startDatetime).toBe(MESSAGES.leadTime);
  });

  test('each mandatory field reports its own error', () => {
    const errors = submit({});
    expect(Object.keys(errors).sort()).toEqual(
      [
        'description',
        'endDatetime',
        'expectedAttendance',
        'preferredLayoutType',
        'purpose',
        'startDatetime',
        'title',
      ].sort()
    );
  });

  test('end time before start time is blocked', () => {
    const errors = submit({ ...validRequest(), endDatetime: inHours(7 * 24 - 1) });
    expect(errors.endDatetime).toBe(MESSAGES.endBeforeStart);
  });

  test.each([0, -5, 12.5, 'abc'])('invalid attendance %p is blocked', (value) => {
    expect(submit({ ...validRequest(), expectedAttendance: value }).expectedAttendance).toBe(
      MESSAGES.attendanceInvalid
    );
  });

  test('attendance sent as a numeric string is accepted', () => {
    expect(submit({ ...validRequest(), expectedAttendance: '150' })).toEqual({});
  });

  test('unknown layout option is blocked', () => {
    expect(submit({ ...validRequest(), preferredLayoutType: 'SPACESHIP' }).preferredLayoutType).toBe(
      MESSAGES.layoutInvalid
    );
  });

  test('registration enabled without capacity is blocked', () => {
    const errors = submit({ ...validRequest(), registrationCapacity: null });
    expect(errors.registrationCapacity).toBe(MESSAGES.registrationCapacityRequired);
  });

  test('registration disabled does not need capacity', () => {
    const errors = submit({ ...validRequest(), isRegistrationEnabled: false, registrationCapacity: null });
    expect(errors).toEqual({});
  });
});

describe('validateDraft (Draft Event Requests)', () => {
  const draft = (input) => validateDraft(input, { allowedLayouts: LAYOUTS });

  test('Draft happy path: title only is enough', () => {
    expect(draft({ title: 'SMU Alumni Gala 2026' })).toEqual({});
  });

  test('draft without a title is blocked', () => {
    expect(draft({ description: 'Some notes' }).title).toBe(MESSAGES.titleRequired);
  });

  test('draft still rejects badly formatted values', () => {
    expect(draft({ title: 'Gala', expectedAttendance: -10 }).expectedAttendance).toBe(
      MESSAGES.attendanceInvalid
    );
  });

  test('draft does not apply the 48-hour rule', () => {
    const errors = validateDraft(
      { title: 'Gala', startDatetime: inHours(1), endDatetime: inHours(2) },
      { allowedLayouts: LAYOUTS }
    );
    expect(errors).toEqual({});
  });

  test('Draft negative TC: submitting a draft with blank attendance shows the exact message', () => {
    const errors = submit({ ...validRequest(), expectedAttendance: '' });
    expect(errors.expectedAttendance).toBe('Expected Attendance is required for submission');
  });
});

describe('validateRequirements (Event Venue and Equipment Requirements)', () => {
  const allowed = { venueIds: [1, 2], equipmentIds: [3, 4] };

  test('valid ordered venue preferences and equipment quantities pass', () => {
    expect(
      validateRequirements(
        { venuePreferences: [2, 1], equipmentRequirements: [{ equipmentId: 3, quantity: 2 }] },
        allowed
      )
    ).toEqual({});
  });

  test('unknown and duplicate venue IDs are rejected', () => {
    expect(validateRequirements({ venuePreferences: [1, 1] }, allowed).venuePreferences).toBe(
      MESSAGES.venuePreferencesInvalid
    );
    expect(validateRequirements({ venuePreferences: [9] }, allowed).venuePreferences).toBe(
      MESSAGES.venuePreferencesInvalid
    );
  });

  test('invalid or duplicate equipment requirements are rejected', () => {
    expect(
      validateRequirements({ equipmentRequirements: [{ equipmentId: 3, quantity: 0 }] }, allowed)
        .equipmentRequirements
    ).toBe(MESSAGES.equipmentRequirementsInvalid);
    expect(
      validateRequirements(
        {
          equipmentRequirements: [
            { equipmentId: 3, quantity: 1 },
            { equipmentId: 3, quantity: 2 },
          ],
        },
        allowed
      ).equipmentRequirements
    ).toBe(MESSAGES.equipmentRequirementsInvalid);
    expect(
      validateRequirements({ equipmentRequirements: [{ equipmentId: 9, quantity: 1 }] }, allowed)
        .equipmentRequirements
    ).toBe(MESSAGES.equipmentRequirementsInvalid);
  });
});