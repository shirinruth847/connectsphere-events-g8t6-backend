jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return {
    ...actual,
    findLeadAssignments: jest.fn(),
    findUnassignedSubmittedEvents: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");

const leadId = 182;
const overviewEndpoints = [
  { path: "/api/events/assignments", read: "findLeadAssignments" },
  { path: "/api/events/unassigned", read: "findUnassignedSubmittedEvents" },
];
const nonLeadRoles = ["ORGANISER", "COORDINATOR", "VENUE_STAFF", "TECH_SUPPORT", "SAFETY_OFFICER", "ATTENDEE"];

const signedInAs = (userId, role) => {
  userModel.verifyAccessToken.mockResolvedValue("spm182-auth-user");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};

const getOverview = (path) => request(app).get(path).set("Authorization", "Bearer spm182-token");

const expectNoEventData = (res) => {
  expect(res.body.assignments).toBeUndefined();
  expect(res.body.events).toBeUndefined();
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("SPM-182 Lead assignment overview access", () => {
  test("[SPM-182-AC1/AC3] should_return_both_overview_sections_to_an_active_lead", async () => {
    signedInAs(leadId, "COORDINATOR_LEAD");
    eventModel.findLeadAssignments.mockResolvedValue([{ eventId: 1, coordinatorId: 20, coordinatorName: "Coordinator" }]);
    eventModel.findUnassignedSubmittedEvents.mockResolvedValue([]);

    const assignments = await getOverview("/api/events/assignments");
    const unassigned = await getOverview("/api/events/unassigned");

    expect(assignments.status).toBe(200);
    expect(assignments.body.assignments).toHaveLength(1);
    expect(eventModel.findLeadAssignments).toHaveBeenCalledWith(leadId);
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.events).toEqual([]);
  });

  describe.each(overviewEndpoints)("$path", ({ path, read }) => {
    test.each(nonLeadRoles)("[SPM-182-AC9][TC-13] should_refuse_%s_with_403_and_no_event_data", async (role) => {
      signedInAs(77, role);

      const res = await getOverview(path);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expectNoEventData(res);
      expect(eventModel[read]).not.toHaveBeenCalled();
    });

    test("[SPM-182-AC9][TC-14] should_refuse_a_signed_out_request_with_401", async () => {
      const res = await request(app).get(path);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHENTICATED");
      expectNoEventData(res);
      expect(userModel.verifyAccessToken).not.toHaveBeenCalled();
      expect(eventModel[read]).not.toHaveBeenCalled();
    });

    test("[SPM-182-AC9][TC-14] should_refuse_an_invalid_token_with_401", async () => {
      userModel.verifyAccessToken.mockResolvedValue(null);

      const res = await getOverview(path);

      expect(res.status).toBe(401);
      expectNoEventData(res);
      expect(eventModel[read]).not.toHaveBeenCalled();
    });

    // findUserByAuthId returns null for an inactive profile, so a deactivated
    // Lead is stopped before any role check or query.
    test("[SPM-182-AC9][TC-15] should_refuse_a_deactivated_lead_with_401", async () => {
      userModel.verifyAccessToken.mockResolvedValue("spm182-auth-user");
      userModel.findUserByAuthId.mockResolvedValue(null);

      const res = await getOverview(path);

      expect(res.status).toBe(401);
      expectNoEventData(res);
      expect(eventModel[read]).not.toHaveBeenCalled();
    });
  });
});
