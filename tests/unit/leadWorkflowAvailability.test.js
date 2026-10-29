// Exercise real Express routes, authentication, authorization and controllers.
// Only the identity lookup and business models are mocked; no shared writes.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/eventModel", () => ({
  ...jest.requireActual("../../model/eventModel"),
  findUnassignedSubmittedEvents: jest.fn(),
  findCoordinatorAvailability: jest.fn(),
  findLeadAssignments: jest.fn(),
  assignCoordinator: jest.fn(),
  reassignCoordinator: jest.fn(),
}));

const request = require("supertest");
const leadId = 10;
const coordinatorId = 20;
const commandKey = "lead-workflow-regression";
const leadRoutes = [
  ["get", "/api/events/unassigned"],
  ["get", "/api/events/coordinator-availability"],
  ["get", "/api/events/assignments"],
  ["post", "/api/events/42/coordinator"],
  ["patch", "/api/events/42/coordinator"],
];
const originalFlag = process.env.ENABLE_COORDINATOR_WORKFLOWS;

describe.each([
  ["unset", undefined],
  ["false", "false"],
])("Lead routes with the retired flag %s", (_label, flag) => {
  let app;
  let userModel;
  let eventModel;

  beforeAll(() => {
    jest.resetModules();
    if (flag === undefined) delete process.env.ENABLE_COORDINATOR_WORKFLOWS;
    else process.env.ENABLE_COORDINATOR_WORKFLOWS = flag;
    app = require("../../app");
    userModel = require("../../model/userModel");
    eventModel = require("../../model/eventModel");
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.ENABLE_COORDINATOR_WORKFLOWS;
    else process.env.ENABLE_COORDINATOR_WORKFLOWS = originalFlag;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    userModel.verifyAccessToken.mockResolvedValue("synthetic-auth-id");
    userModel.findUserByAuthId.mockResolvedValue({ user_id: leadId, role: "COORDINATOR_LEAD", organisation_ids: [] });
    eventModel.findUnassignedSubmittedEvents.mockResolvedValue([{
      event_id: 42, title: "Synthetic queued request", status: "SUBMITTED",
      coordinator_id: null, start_datetime: "2030-01-31T02:00:00Z",
      end_datetime: "2030-01-31T04:00:00Z", created_at: "2026-10-01T00:00:00Z",
    }]);
    eventModel.findCoordinatorAvailability.mockResolvedValue([]);
    eventModel.findLeadAssignments.mockResolvedValue([]);
    eventModel.assignCoordinator.mockResolvedValue({ event_id: 42, status: "UNDER_REVIEW", coordinator_id: coordinatorId });
    eventModel.reassignCoordinator.mockResolvedValue({ event: { eventId: 42, coordinatorId }, coordinator: { coordinatorId, name: "Synthetic Coordinator" }, replayed: false });
  });

  const signedRequest = (method, path, body) => {
    const pending = request(app)[method](path).set("Authorization", "Bearer synthetic-token").set("Idempotency-Key", commandKey);
    return body ? pending.send(body) : pending;
  };

  test.each(leadRoutes)("requires authentication for %s %s", async (method, path) => {
    const response = await request(app)[method](path);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("UNAUTHENTICATED");
    expect(userModel.verifyAccessToken).not.toHaveBeenCalled();
    expect(eventModel.assignCoordinator).not.toHaveBeenCalled();
    expect(eventModel.reassignCoordinator).not.toHaveBeenCalled();
  });

  test.each(leadRoutes)("denies a regular Coordinator on %s %s", async (method, path) => {
    userModel.findUserByAuthId.mockResolvedValue({ user_id: coordinatorId, role: "COORDINATOR", organisation_ids: [] });
    const response = await signedRequest(method, path);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
    expect(eventModel.findUnassignedSubmittedEvents).not.toHaveBeenCalled();
    expect(eventModel.findCoordinatorAvailability).not.toHaveBeenCalled();
    expect(eventModel.findLeadAssignments).not.toHaveBeenCalled();
    expect(eventModel.assignCoordinator).not.toHaveBeenCalled();
    expect(eventModel.reassignCoordinator).not.toHaveBeenCalled();
  });

  test.each(["ORGANISER", "ATTENDEE", "VENUE_STAFF", "TECH_SUPPORT", "SAFETY_OFFICER"])("denies queue disclosure to %s", async role => {
    userModel.findUserByAuthId.mockResolvedValue({ user_id: 30, role, organisation_ids: [] });
    const response = await signedRequest("get", "/api/events/unassigned");
    expect(response.status).toBe(403);
    expect(eventModel.findUnassignedSubmittedEvents).not.toHaveBeenCalled();
  });

  test("returns submitted requests to the verified Lead without an environment opt-in", async () => {
    const response = await signedRequest("get", "/api/events/unassigned");
    expect(response.status).toBe(200);
    expect(response.body.events).toEqual([expect.objectContaining({ eventId: 42, requestId: "REQ-000042", title: "Synthetic queued request", status: "SUBMITTED" })]);
    expect(userModel.verifyAccessToken).toHaveBeenCalledWith("synthetic-token");
    expect(userModel.findUserByAuthId).toHaveBeenCalledWith("synthetic-auth-id");
  });

  test("allows Lead availability reads", async () => {
    const response = await signedRequest("get", "/api/events/coordinator-availability");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ coordinators: [] });
  });

  test("scopes supervised assignment reads to the trusted Lead", async () => {
    const response = await signedRequest("get", "/api/events/assignments");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ assignments: [] });
    expect(eventModel.findLeadAssignments).toHaveBeenCalledWith(leadId);
  });

  test("keeps initial assignment attributed to the trusted Lead", async () => {
    const response = await signedRequest("post", "/api/events/42/coordinator", { coordinatorId });
    expect(response.status).toBe(200);
    expect(eventModel.assignCoordinator).toHaveBeenCalledWith({ eventId: 42, coordinatorId, leadId });
  });

  test("keeps reassignment command identity and expected-coordinator checks", async () => {
    const response = await signedRequest("patch", "/api/events/42/coordinator", { coordinatorId, expectedCoordinatorId: 19 });
    expect(response.status).toBe(200);
    expect(response.body.replayed).toBe(false);
    expect(eventModel.reassignCoordinator).toHaveBeenCalledWith({ eventId: 42, coordinatorId, expectedCoordinatorId: 19, leadId, idempotencyKey: commandKey });
  });

  test.each(["invalid token", "missing trusted profile"])("rejects %s", async scenario => {
    if (scenario === "invalid token") userModel.verifyAccessToken.mockResolvedValue(null);
    else userModel.findUserByAuthId.mockResolvedValue(null);
    const response = await signedRequest("get", "/api/events/unassigned");
    expect(response.status).toBe(401);
    expect(eventModel.findUnassignedSubmittedEvents).not.toHaveBeenCalled();
  });
});
