jest.mock("../../config/supabase", () => ({ from: jest.fn(), auth: {} }));

const { buildOrganiserVisibilityFilter } = require("../../model/eventModel");
const { toAttendeeEvent } = require("../../model/registrationModel");

describe("buildOrganiserVisibilityFilter", () => {
  test("limits an organiser without organisations to their own requests", () => {
    expect(buildOrganiserVisibilityFilter({ user_id: 7, organisation_ids: [] })).toBe("organiser_id.eq.7");
  });

  test("adds submitted requests from the organiser's verified organisations", () => {
    expect(buildOrganiserVisibilityFilter({ user_id: 7, organisation_ids: [3, 9] }))
      .toBe("organiser_id.eq.7,and(organisation_id.in.(3,9),status.neq.DRAFT)");
  });
});

describe("toAttendeeEvent", () => {
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

  test("shows the approved venue for a confirmed event", () => {
    const view = toAttendeeEvent({ ...baseEvent, status: "CONFIRMED" });
    expect(view.status).toBe("CONFIRMED");
    expect(view.venue).toEqual({ name: "Main Hall", address: "2 Main Rd" });
  });

  test("hides internal planning state and the provisional venue", () => {
    const view = toAttendeeEvent({ ...baseEvent, status: "PLANNING" });
    expect(view.status).toBe("PENDING_CONFIRMATION");
    expect(view.venue).toBeNull();
  });

  test("exposes only attendee-safe fields", () => {
    const view = toAttendeeEvent({ ...baseEvent, status: "CONFIRMED", organiser_id: 4, coordinator_id: 5 });
    expect(Object.keys(view).sort()).toEqual(
      ["description", "end_datetime", "event_id", "start_datetime", "status", "title", "venue"],
    );
  });
});
