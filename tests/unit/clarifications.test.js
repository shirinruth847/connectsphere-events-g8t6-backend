// Unit tests for SPM-41 clarification rounds: GET /api/events/:id/clarifications
// through the real Express app, routes, middleware and access policy, and the
// model's query and response shape. Only Supabase-facing functions are mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/activityModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return { ...actual, findVisibleEvent: jest.fn(), findEventClarifications: jest.fn() };
});

const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");

const { findEventClarifications: realFindEventClarifications } = jest.requireActual("../../model/eventModel");

const ORGANISER_ID = 11;
const COLLEAGUE_ID = 12;
const COORDINATOR_ID = 21;
const ORGANISATION_ID = 5;

const eventRow = (overrides = {}) => ({
  event_id: 42,
  organiser_id: ORGANISER_ID,
  organisation_id: ORGANISATION_ID,
  coordinator_id: COORDINATOR_ID,
  status: "AWAITING_CLARIFICATION",
  title: "SMU Alumni Gala 2026",
  version: 4,
  ...overrides,
});

const signedInAs = (role, userId, organisationIds = []) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: organisationIds });
};

const getRounds = (path = "/api/events/42/clarifications") =>
  request(app).get(path).set("Authorization", "Bearer token");

const rounds = [
  {
    clarificationId: 8,
    round: 2,
    status: "OPEN",
    message: "Please confirm the stage size.",
    requestedAt: "2026-10-20T02:00:00+00:00",
    requestedBy: { userId: COORDINATOR_ID, name: "Coordinator C" },
    response: null,
    respondedAt: null,
    respondedBy: null,
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  eventModel.findVisibleEvent.mockResolvedValue(eventRow());
  eventModel.findEventClarifications.mockResolvedValue(rounds);
});

describe("GET /api/events/:id/clarifications (SPM-41 AC3)", () => {
  test("[SPM-41-AC3] should_return_every_round_when_the_owner_opens_the_clarifications", async () => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clarifications: rounds });
    expect(eventModel.findEventClarifications).toHaveBeenCalledWith(42);
  });

  test("[SPM-41-AC3] should_return_the_rounds_read_only_when_a_same_organisation_organiser_opens_them", async () => {
    signedInAs("ORGANISER", COLLEAGUE_ID, [ORGANISATION_ID]);

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(res.body.clarifications).toEqual(rounds);
  });

  test("[SPM-41-AC3] should_return_the_rounds_when_the_assigned_coordinator_opens_them", async () => {
    signedInAs("COORDINATOR", COORDINATOR_ID);

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(res.body.clarifications).toEqual(rounds);
  });

  test("[SPM-41-TC-04] should_keep_answered_rounds_visible_after_the_event_returns_to_review", async () => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status: "UNDER_REVIEW" }));
    const answered = [{ ...rounds[0], status: "RESPONDED", response: "A 6m stage.", respondedAt: "2026-10-21T01:00:00+00:00", respondedBy: { userId: ORGANISER_ID, name: "Owner O" } }];
    eventModel.findEventClarifications.mockResolvedValue(answered);

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(res.body.clarifications).toEqual(answered);
  });

  test("[SPM-41-AC3] should_return_an_empty_list_when_the_event_has_never_been_returned", async () => {
    signedInAs("COORDINATOR", COORDINATOR_ID);
    eventModel.findVisibleEvent.mockResolvedValue(eventRow({ status: "UNDER_REVIEW" }));
    eventModel.findEventClarifications.mockResolvedValue([]);

    const res = await getRounds();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clarifications: [] });
  });

  test.each([
    ["a coordinator who is not assigned", "COORDINATOR", 99, []],
    ["an organiser from another organisation", "ORGANISER", 13, [77]],
    ["a coordinator lead", "COORDINATOR_LEAD", 31, []],
    ["venue staff", "VENUE_STAFF", 41, []],
    ["an attendee", "ATTENDEE", 51, []],
  ])("[SPM-41-AC3] should_answer_404_without_reading_rounds_for_%s", async (_label, role, userId, organisationIds) => {
    signedInAs(role, userId, organisationIds);

    const res = await getRounds();

    expect(res.status).toBe(404);
    expect(eventModel.findEventClarifications).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_404_when_the_event_does_not_exist", async () => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    eventModel.findVisibleEvent.mockResolvedValue(null);

    const res = await getRounds("/api/events/999/clarifications");

    expect(res.status).toBe(404);
    expect(eventModel.findEventClarifications).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_404_for_an_event_id_that_is_not_a_number", async () => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);

    const res = await getRounds("/api/events/abc/clarifications");

    expect(res.status).toBe(404);
    expect(eventModel.findVisibleEvent).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_answer_401_without_a_token", async () => {
    const res = await request(app).get("/api/events/42/clarifications");

    expect(res.status).toBe(401);
    expect(eventModel.findEventClarifications).not.toHaveBeenCalled();
  });

  test("[SPM-41-AC3] should_return_a_safe_500_when_the_rounds_cannot_be_read", async () => {
    signedInAs("ORGANISER", ORGANISER_ID, [ORGANISATION_ID]);
    eventModel.findEventClarifications.mockRejectedValue(new Error("[Supabase Error] relation does not exist"));

    const res = await getRounds();

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("relation");
  });
});

describe("findEventClarifications (SPM-41)", () => {
  const queryReturning = (result) => {
    const query = { select: jest.fn(() => query), eq: jest.fn(() => query) };
    query.order = jest.fn().mockResolvedValue(result);
    return query;
  };

  test("[SPM-41-AC3] should_read_one_events_rounds_newest_first_and_name_both_people", async () => {
    const query = queryReturning({
      data: [
        {
          clarification_id: 8,
          round_number: 2,
          status: "OPEN",
          message: "Please confirm the stage size.",
          requested_at: "2026-10-20T02:00:00+00:00",
          requested_by: COORDINATOR_ID,
          requester: { name: "Coordinator C" },
          response: null,
          responded_at: null,
          responded_by: null,
          responder: null,
        },
        {
          clarification_id: 5,
          round_number: 1,
          status: "RESPONDED",
          message: "What is the expected attendance?",
          requested_at: "2026-10-18T02:00:00+00:00",
          requested_by: COORDINATOR_ID,
          requester: { name: "Coordinator C" },
          response: null,
          responded_at: "2026-10-19T02:00:00+00:00",
          responded_by: ORGANISER_ID,
          responder: { name: "Owner O" },
        },
      ],
      error: null,
    });
    supabase.from.mockReturnValue(query);

    const result = await realFindEventClarifications(42);

    expect(supabase.from).toHaveBeenCalledWith("clarifications");
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("requester:user!clarifications_requested_by_fkey(name)"));
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining("responder:user!clarifications_responded_by_fkey(name)"));
    expect(query.eq).toHaveBeenCalledWith("event_id", 42);
    expect(query.order).toHaveBeenCalledWith("round_number", { ascending: false });
    expect(result).toEqual([
      rounds[0],
      {
        clarificationId: 5,
        round: 1,
        status: "RESPONDED",
        message: "What is the expected attendance?",
        requestedAt: "2026-10-18T02:00:00+00:00",
        requestedBy: { userId: COORDINATOR_ID, name: "Coordinator C" },
        // Answered with amendments only: no written response (team decision 2).
        response: null,
        respondedAt: "2026-10-19T02:00:00+00:00",
        respondedBy: { userId: ORGANISER_ID, name: "Owner O" },
      },
    ]);
  });

  test("[SPM-41-AC3] should_throw_instead_of_returning_an_empty_list_when_the_query_fails", async () => {
    supabase.from.mockReturnValue(queryReturning({ data: null, error: { message: "permission denied" } }));

    await expect(realFindEventClarifications(42)).rejects.toThrow("permission denied");
  });
});
