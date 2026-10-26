// SPM-44 route-level unit tests for the Attendee Event Dashboard endpoints:
// real Express app, routes, authentication/role middleware, pagination
// validation and controller. Only the model calls that reach Supabase are mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return {
    ...actual,
    findVisibleEvent: jest.fn(),
    findPublishedAttendeeEvents: jest.fn(),
    findPublishedAttendeeEvent: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");

const ATTENDEE_ID = 77;
const NON_ATTENDEE_ROLES = ["ORGANISER", "COORDINATOR", "COORDINATOR_LEAD", "VENUE_STAFF", "TECH_SUPPORT"];
const NOT_FOUND = { error: "Event request not found.", code: "EVENT_NOT_FOUND" };
const FORBIDDEN = { error: "You do not have permission to access this resource.", code: "FORBIDDEN" };

const card = {
  eventId: 501,
  title: "Synthetic Showcase",
  description: "Public description",
  startDatetime: "2027-03-02T01:00:00+00:00",
  endDatetime: "2027-03-02T03:00:00+00:00",
  organisationName: "Synthetic Organisation",
  location: "Main Hall, 2 Main Rd",
  registrationAvailability: "OPEN",
};

const signedInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: ATTENDEE_ID, role, organisation_ids: [] });
};

const get = (path) => request(app).get(path).set("Authorization", "Bearer token");

const domainError = (code) => Object.assign(new Error(code), { name: "EventRequestError", code });

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("[SPM-44] authentication and ATTENDEE-only access", () => {
  test.each(["/api/events/discovery", "/api/events/discovery/501"])(
    "[TC-AUTH-005] should_return_401_without_querying_when_no_token_is_sent_to_%s",
    async (path) => {
      const res = await request(app).get(path);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
      expect(eventModel.findPublishedAttendeeEvents).not.toHaveBeenCalled();
      expect(eventModel.findPublishedAttendeeEvent).not.toHaveBeenCalled();
    },
  );

  test("[TC-AUTH-005] should_return_401_when_the_token_is_rejected_by_supabase", async () => {
    userModel.verifyAccessToken.mockResolvedValue(null);

    const res = await get("/api/events/discovery");

    expect(res.status).toBe(401);
    expect(eventModel.findPublishedAttendeeEvents).not.toHaveBeenCalled();
  });

  test.each(NON_ATTENDEE_ROLES)("[SPM-44] should_return_403_without_querying_when_%s_lists_discovery", async (role) => {
    signedInAs(role);

    const res = await get("/api/events/discovery");

    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN);
    expect(eventModel.findPublishedAttendeeEvents).not.toHaveBeenCalled();
  });

  test.each(NON_ATTENDEE_ROLES)("[SPM-44] should_return_403_without_querying_when_%s_opens_discovery_detail", async (role) => {
    signedInAs(role);

    const res = await get("/api/events/discovery/501");

    expect(res.status).toBe(403);
    expect(eventModel.findPublishedAttendeeEvent).not.toHaveBeenCalled();
  });
});

describe("[SPM-44] GET /api/events/discovery", () => {
  test("[TC-EVENT-001/003] should_return_each_eligible_event_as_a_separate_card_when_attendee_lists_events", async () => {
    signedInAs("ATTENDEE");
    const second = { ...card, eventId: 502, title: "Second Showcase" };
    eventModel.findPublishedAttendeeEvents.mockResolvedValue({ events: [card, second], nextCursor: null });

    const res = await get("/api/events/discovery");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ events: [card, second], nextCursor: null });
  });

  test("[TC-EVENT-007/AC6] should_return_200_with_an_empty_list_and_null_cursor_when_no_event_is_eligible", async () => {
    signedInAs("ATTENDEE");
    eventModel.findPublishedAttendeeEvents.mockResolvedValue({ events: [], nextCursor: null });

    const res = await get("/api/events/discovery");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], nextCursor: null });
  });

  test("[SPM-44] should_pass_only_validated_paging_to_the_model_when_client_sends_extra_query_values", async () => {
    signedInAs("ATTENDEE");
    eventModel.findPublishedAttendeeEvents.mockResolvedValue({ events: [], nextCursor: null });
    const cursor = eventModel.encodeDiscoveryCursor({ start_datetime: card.startDatetime, event_id: 501 });

    await get(`/api/events/discovery?limit=20&cursor=${cursor}&status=DRAFT&userId=9&published=false`);

    expect(eventModel.findPublishedAttendeeEvents).toHaveBeenCalledWith({ limit: 20, cursor });
  });

  test.each([
    ["limit=0", "limit"],
    ["limit=101", "limit"],
    ["limit=abc", "limit"],
    ["cursor=has%20space", "cursor"],
    ["offset=50", "offset"],
  ])("[TC-AUTH-021] should_return_400_without_querying_when_query_is_%s", async (query, field) => {
    signedInAs("ATTENDEE");

    const res = await get(`/api/events/discovery?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.fields).toHaveProperty(field);
    expect(eventModel.findPublishedAttendeeEvents).not.toHaveBeenCalled();
  });

  test("[TC-AUTH-021] should_return_400_when_the_model_rejects_a_well_formed_but_invalid_cursor", async () => {
    signedInAs("ATTENDEE");
    eventModel.findPublishedAttendeeEvents.mockRejectedValue(domainError("INVALID_CURSOR"));

    const res = await get("/api/events/discovery?cursor=eyJmb28iOiJiYXIifQ");

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ cursor: "Invalid page cursor." });
  });

  test("[TC-AUTH-018] should_return_a_generic_500_without_internal_detail_when_the_query_fails", async () => {
    signedInAs("ATTENDEE");
    eventModel.findPublishedAttendeeEvents.mockRejectedValue(new Error("relation \"event\" secret-detail"));

    const res = await get("/api/events/discovery");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error", code: "INTERNAL_ERROR" });
  });
});

describe("[SPM-44] GET /api/events/discovery/:id", () => {
  test("[TC-EVENT-004] should_return_the_attendee_detail_when_the_event_is_visible", async () => {
    signedInAs("ATTENDEE");
    const detail = { ...card, registrationOpenAt: null, registrationCloseAt: null };
    eventModel.findPublishedAttendeeEvent.mockResolvedValue(detail);

    const res = await get("/api/events/discovery/501");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ event: detail });
    expect(eventModel.findPublishedAttendeeEvent).toHaveBeenCalledWith(501);
  });

  test("[SPM-44 AC2] should_return_404_when_the_event_is_hidden_or_unknown", async () => {
    signedInAs("ATTENDEE");
    eventModel.findPublishedAttendeeEvent.mockResolvedValue(null);

    const res = await get("/api/events/discovery/501");

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  });

  test.each(["abc", "0", "-1", "1.5", "01", "2147483648", "1e3"])(
    "[SPM-44 AC2] should_return_the_same_404_without_querying_when_id_is_%s",
    async (id) => {
      signedInAs("ATTENDEE");

      const res = await get(`/api/events/discovery/${id}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
      expect(eventModel.findPublishedAttendeeEvent).not.toHaveBeenCalled();
    },
  );
});

describe("[SPM-44 AC2] organiser event route stays closed to attendees", () => {
  test("should_return_404_for_get_events_id_when_an_attendee_requests_an_existing_event", async () => {
    signedInAs("ATTENDEE");
    eventModel.findVisibleEvent.mockResolvedValue({
      event_id: 501, organiser_id: 11, coordinator_id: 12, status: "CONFIRMED", organisation_id: 3, is_published: true,
    });

    const res = await get("/api/events/501");

    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  });
});
