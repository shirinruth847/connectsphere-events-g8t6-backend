jest.mock("../config/supabase", () => ({
  from: jest.fn(),
  rpc: jest.fn(),
}));

const supabase = require("../config/supabase");
const eventModel = require("../model/eventModel");
const eventController = require("../controller/eventController");
const { requireRole } = require("../middleware/authorize");
const { USER_ROLES } = require("../config/eventConstants");

const makeResponse = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

const leadId = 10;
const coordinatorId = 7;

const authReq = (body) => ({
  params: { id: "42" },
  body,
  user: { user_id: leadId, role: USER_ROLES.COORDINATOR_LEAD },
});

describe("[SPM-174] unassigned event queue", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test("TC-SPM-174-AC2: returns submitted unassigned events in start-time order", async () => {
    const rows = [
      {
        event_id: 2,
        status: "SUBMITTED",
        coordinator_id: null,
        start_datetime: "2026-10-21T09:00:00.000Z",
      },
    ];
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
    };
    query.order.mockImplementation(() => query);
    query.then = (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve);
    supabase.from.mockReturnValue(query);

    await expect(eventModel.findUnassignedSubmittedEvents()).resolves.toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("event");
    expect(query.eq).toHaveBeenCalledWith("status", "SUBMITTED");
    expect(query.is).toHaveBeenCalledWith("coordinator_id", null);
    expect(query.order).toHaveBeenNthCalledWith(1, "submitted_at", { ascending: true, nullsFirst: false });
    expect(query.order).toHaveBeenNthCalledWith(2, "created_at", { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(3, "event_id", { ascending: true });
  });

  test("TC-SPM-174-AC2: maps queue rows to the public event response", async () => {
    const event = {
      event_id: 42,
      status: "SUBMITTED",
      title: "Example event",
      purpose: "Community outreach",
      submitted_at: "2026-10-20T08:30:00.000Z",
      start_datetime: "2026-10-20T09:00:00.000Z",
      end_datetime: "2026-10-20T12:00:00.000Z",
      event_venue_preference: [
        { venue_id: 8, preference_order: 2 },
        { venue_id: 3, preference_order: 1 },
      ],
      event_equipment_requirement: [{ equipment_id: 4, quantity_requested: 2 }],
    };
    jest.spyOn(eventModel, "findUnassignedSubmittedEvents").mockResolvedValue([event]);
    const res = makeResponse();

    await eventController.getUnassignedEvents({}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      events: [eventModel.toUnassignedQueueItem(event)],
    });
    expect(res.json.mock.calls[0][0].events[0]).toMatchObject({
      purpose: "Community outreach",
      submittedAt: "2026-10-20T08:30:00.000Z",
      venuePreferences: [3, 8],
      equipmentRequirements: [{ equipmentId: 4, quantity: 2 }],
    });
  });

  test("TC-SPM-174-AC4: permits only Coordinator Lead profiles", () => {
    const next = jest.fn();
    const middleware = requireRole(USER_ROLES.COORDINATOR_LEAD);

    middleware({ user: { role: USER_ROLES.COORDINATOR_LEAD } }, makeResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test("TC-SPM-174-AC4: rejects a regular coordinator", () => {
    const next = jest.fn();
    const res = makeResponse();
    const middleware = requireRole(USER_ROLES.COORDINATOR_LEAD);

    middleware({ user: { role: USER_ROLES.COORDINATOR } }, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "You do not have permission to access this resource.",
      code: "FORBIDDEN",
    });
    expect(next).not.toHaveBeenCalled();
  });

  test("[SPM-174-AC3] returns active coordinator schedules with event counts", async () => {
    const userRows = [
      { user_id: 7, name: "Alice Coordinator" },
      { user_id: 8, name: "Bob Coordinator" },
    ];
    const users = {
      data: userRows,
      error: null,
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: userRows, error: null }),
    };
    const eventRows = [
      {
        event_id: 91,
        coordinator_id: 7,
        status: "CONFIRMED",
        title: "Alice event",
        start_datetime: "2026-11-01T09:00:00.000Z",
        end_datetime: "2026-11-01T10:00:00.000Z",
      },
      {
        event_id: 92,
        coordinator_id: 7,
        status: "PLANNING",
        title: "Alice second event",
        start_datetime: "2026-11-02T09:00:00.000Z",
        end_datetime: "2026-11-02T10:00:00.000Z",
      },
    ];
    const events = {
      data: eventRows,
      error: null,
      select: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnThis(),
      order: jest.fn().mockResolvedValue({ data: eventRows, error: null }),
    };
    supabase.from.mockImplementation((table) => (table === "user" ? users : events));

    await expect(eventModel.findCoordinatorAvailability()).resolves.toEqual([
      expect.objectContaining({ coordinatorId: 7, name: "Alice Coordinator", events: expect.any(Array) }),
      expect.objectContaining({ coordinatorId: 8, name: "Bob Coordinator", events: [] }),
    ]);
    expect(users.eq).toHaveBeenNthCalledWith(1, "role", "COORDINATOR");
    expect(users.eq).toHaveBeenNthCalledWith(2, "is_active", true);
    expect(events.not).toHaveBeenCalledWith("coordinator_id", "is", null);
    expect(events.not).toHaveBeenCalledWith("status", "in", '("DRAFT","COMPLETED","REJECTED","CANCELLED")');
    expect(events.order).toHaveBeenCalledWith("start_datetime", { ascending: true });
  });

  test("[SPM-174-AC3] rejects an assignment when the coordinator has an overlapping event", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { message: "COORDINATOR_CONFLICT", code: "P0001" } });

    await expect(eventModel.assignCoordinator({ eventId: 42, coordinatorId: coordinatorId, leadId })).rejects.toMatchObject({
      name: "EventRequestError",
      code: "COORDINATOR_CONFLICT",
    });
    expect(supabase.rpc).toHaveBeenCalledWith("assign_event_coordinator", {
      p_event_id: 42,
      p_coordinator_id: coordinatorId,
      p_lead_id: leadId,
    });
  });

  test("[SPM-174-AC3] allows an assignment when an existing event only touches a boundary", async () => {
    const updated = {
      event_id: 42,
      status: "SUBMITTED",
      coordinator_id: coordinatorId,
      start_datetime: "2026-11-01T10:00:00.000Z",
      end_datetime: "2026-11-01T12:00:00.000Z",
    };
    supabase.rpc.mockResolvedValue({ data: { event: updated }, error: null });

    await expect(eventModel.assignCoordinator({ eventId: 42, coordinatorId: coordinatorId, leadId })).resolves.toEqual(updated);
    expect(supabase.rpc).toHaveBeenCalledWith("assign_event_coordinator", {
      p_event_id: 42,
      p_coordinator_id: coordinatorId,
      p_lead_id: leadId,
    });
  });

  test("[SPM-174-AC2] rejects malformed assignment input before querying the database", async () => {
    const res = makeResponse();

    await eventController.patchCoordinator(authReq({}), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Please correct the highlighted fields.",
      code: "VALIDATION_FAILED",
      fields: { coordinatorId: "Send a positive integer coordinatorId." },
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  test("[SPM-174-AC2] rejects a non-integer coordinator id before querying the database", async () => {
    const res = makeResponse();

    await eventController.patchCoordinator(authReq({ coordinatorId: "7" }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Select an active Event Coordinator.",
      code: "INVALID_COORDINATOR",
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
