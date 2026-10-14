jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => {
  const actual = jest.requireActual("../../model/eventModel");
  return {
    ...actual,
    findCoordinatorEvents: jest.fn(),
    findLeadAssignments: jest.fn(),
    findUnassignedSubmittedEvents: jest.fn(),
    findCoordinatorAvailability: jest.fn(),
    assignCoordinator: jest.fn(),
    findVisibleEvent: jest.fn(),
    reassignCoordinator: jest.fn(),
  };
});

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const eventModel = require("../../model/eventModel");

const leadId = 10;
const coordinatorId = 20;

const signedInAs = (userId, role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};

const send = (method, path, body) => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  return body === undefined ? req : req.send(body);
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("PATCH /api/events/:id/coordinator", () => {
  test("[SPM-180-AC1/AC2] should_return_the_new_assignment_when_an_authorised_lead_reassigns", async () => {
    signedInAs(leadId, "COORDINATOR_LEAD");
    eventModel.reassignCoordinator.mockResolvedValue({
      event: { eventId: 42, requestId: "REQ-000042", title: "Conference", status: "SUBMITTED", coordinatorId },
      coordinator: { coordinatorId, name: "Coordinator Two" },
    });

    const res = await send("patch", "/api/events/42/coordinator", { coordinatorId, expectedCoordinatorId: 19 });

    expect(res.status).toBe(200);
    expect(res.body.coordinator).toEqual({ coordinatorId, name: "Coordinator Two" });
    expect(eventModel.reassignCoordinator).toHaveBeenCalledWith({ eventId: 42, coordinatorId, expectedCoordinatorId: 19, leadId });
  });

  test("[SPM-180-AC6] should_reject_reassignment_when_the_actor_is_not_a_lead", async () => {
    signedInAs(coordinatorId, "COORDINATOR");

    const res = await send("patch", "/api/events/42/coordinator", { coordinatorId: 21, expectedCoordinatorId: 19 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(eventModel.reassignCoordinator).not.toHaveBeenCalled();
  });

  test.each([
    [{ coordinatorId: "21", expectedCoordinatorId: 19 }],
    [{ coordinatorId: 0, expectedCoordinatorId: 19 }],
    [{ coordinatorId: 21, expectedCoordinatorId: 0 }],
    [{ coordinatorId: 21, expectedCoordinatorId: 19, leadId }],
    [{}],
  ])("[SPM-180-AC6] should_reject_invalid_or_server_controlled_input_%p", async (body) => {
    signedInAs(leadId, "COORDINATOR_LEAD");

    const res = await send("patch", "/api/events/42/coordinator", body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(eventModel.reassignCoordinator).not.toHaveBeenCalled();
  });
});

describe("POST /api/events/:id/coordinator initial assignment", () => {
  test("should_allow_only_a_lead_to_assign_an_unassigned_request", async () => {
    signedInAs(leadId, "COORDINATOR_LEAD");
    eventModel.assignCoordinator.mockResolvedValue({
      event_id: 42,
      title: "Conference",
      status: "SUBMITTED",
      coordinator_id: coordinatorId,
    });

    const res = await send("post", "/api/events/42/coordinator", { coordinatorId });

    expect(res.status).toBe(200);
    expect(res.body.event.eventId).toBe(42);
    expect(res.body.event.status).toBe("SUBMITTED");
    expect(eventModel.assignCoordinator).toHaveBeenCalledWith({ eventId: 42, coordinatorId, leadId });
  });
});

describe("Coordinator event access", () => {
  test("[SPM-180-AC4] should_list_events_using_only_the_authenticated_coordinator_id", async () => {
    signedInAs(coordinatorId, "COORDINATOR");
    eventModel.findCoordinatorEvents.mockResolvedValue([{ eventId: 42, title: "Conference" }]);

    const res = await send("get", "/api/events/assigned");

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([{ eventId: 42, title: "Conference" }]);
    expect(eventModel.findCoordinatorEvents).toHaveBeenCalledWith(coordinatorId);
  });

  test("[SPM-180-AC3] should_hide_event_when_it_is_no_longer_assigned_to_this_coordinator", async () => {
    signedInAs(coordinatorId, "COORDINATOR");
    eventModel.findVisibleEvent.mockResolvedValue(null);

    const res = await send("get", "/api/events/42");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
    expect(eventModel.findVisibleEvent).toHaveBeenCalledWith(42, expect.objectContaining({ user_id: coordinatorId }));
  });
});

describe("Lead assignment workspace reads", () => {
  test("[SPM-180] should_return_active_assignments_to_a_lead", async () => {
    signedInAs(leadId, "COORDINATOR_LEAD");
    eventModel.findLeadAssignments.mockResolvedValue([{ eventId: 42, coordinatorId, coordinatorName: "Coordinator" }]);

    const res = await send("get", "/api/events/assignments");

    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
    expect(eventModel.findLeadAssignments).toHaveBeenCalledTimes(1);
  });

  test("[SPM-180] should_reject_coordinator_access_to_the_lead_assignment_workspace", async () => {
    signedInAs(coordinatorId, "COORDINATOR");

    const res = await send("get", "/api/events/assignments");

    expect(res.status).toBe(403);
    expect(eventModel.findLeadAssignments).not.toHaveBeenCalled();
  });
});
