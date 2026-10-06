jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));

const { buildOrganiserVisibilityFilter } = require("../../model/eventModel");
const { toAttendeeEvent } = require("../../model/registrationModel");

const CANONICAL_EVENT_STATES = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "AWAITING_CLARIFICATION", "PLANNING",
  "CONFIRMED", "COMPLETED", "REJECTED", "CANCELLED",
];

describe("[TC-LOGIN-005] buildOrganiserVisibilityFilter", () => {
  test("should_limit_to_own_requests_when_organiser_has_no_organisations", () => {
    expect(buildOrganiserVisibilityFilter({ user_id: 7, organisation_ids: [] })).toBe("organiser_id.eq.7");
  });

  test("should_add_non_draft_organisation_requests_when_organiser_has_memberships", () => {
    expect(buildOrganiserVisibilityFilter({ user_id: 7, organisation_ids: [3, 9] }))
      .toBe("organiser_id.eq.7,and(organisation_id.in.(3,9),status.neq.DRAFT)");
  });
});

describe("[TC-LOGIN-004] toAttendeeEvent", () => {
  const baseEvent = {
    event_id: 1,
    title: "Launch",
    description: "Public description",
    start_datetime: "2026-11-01T01:00:00Z",
    end_datetime: "2026-11-01T03:00:00Z",
    venue_booking: [
      { status: "REJECTED", room: { venue: { name: "Old Hall", address: "1 Old Rd" } } },
      { status: "APPROVED", room: { venue: { name: "Main Hall", address: "2 Main Rd" } } },
    ],
  };

  test("[TC-REG-002] should_show_approved_venue_when_event_is_confirmed", () => {
    const view = toAttendeeEvent({ ...baseEvent, status: "CONFIRMED" });
    expect(view.attendee_status).toBe("CONFIRMED");
    expect(view.venue).toEqual({ name: "Main Hall", address: "2 Main Rd" });
  });

  test.each(["SUBMITTED", "UNDER_REVIEW", "AWAITING_CLARIFICATION", "PLANNING"])(
    "[TC-REG-003] should_report_pending_confirmation_and_hide_venue_when_event_is_%s",
    (status) => {
      const view = toAttendeeEvent({ ...baseEvent, status });
      expect(view.attendee_status).toBe("PENDING_CONFIRMATION");
      expect(view.venue).toBeNull();
    },
  );

  test("[TC-REG-004] should_not_put_display_values_in_a_lifecycle_status_field_when_projecting_events", () => {
    for (const status of CANONICAL_EVENT_STATES) {
      const view = toAttendeeEvent({ ...baseEvent, status });
      expect(view).not.toHaveProperty("status");
    }
  });

  test("should_expose_only_attendee_safe_fields_when_event_has_internal_fields", () => {
    const view = toAttendeeEvent({ ...baseEvent, status: "CONFIRMED", organiser_id: 4, coordinator_id: 5 });
    expect(Object.keys(view).sort()).toEqual(
      ["attendee_status", "description", "end_datetime", "event_id", "start_datetime", "title", "venue"],
    );
  });
});
