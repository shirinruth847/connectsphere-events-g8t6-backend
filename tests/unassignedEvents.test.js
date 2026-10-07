jest.mock("../config/supabase", () => ({
  from: jest.fn(),
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

const chain = (result) => {
  const query = {};
  for (const method of ["select", "eq", "is", "not", "lt", "gt", "order", "update"]) {
    query[method] = jest.fn(() => query);
  }
  query.maybeSingle = jest.fn().mockResolvedValue(result);
  query.single = jest.fn().mockResolvedValue(result);
  return query;
};

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
    query.order.mockImplementationOnce(() => query).mockResolvedValue({ data: rows, error: null });
    supabase.from.mockReturnValue(query);

    await expect(eventModel.findUnassignedSubmittedEvents()).resolves.toEqual(rows);
    expect(supabase.from).toHaveBeenCalledWith("event");
    expect(query.eq).toHaveBeenCalledWith("status", "SUBMITTED");
    expect(query.is).toHaveBeenCalledWith("coordinator_id", null);
    expect(query.order).toHaveBeenNthCalledWith(1, "start_datetime", { ascending: true });
    expect(query.order).toHaveBeenNthCalledWith(2, "event_id", { ascending: true });
  });

  test("TC-SPM-174-AC2: maps queue rows to the public event response", async () => {
    const event = {
      event_id: 42,
      status: "SUBMITTED",
      title: "Example event",
      start_datetime: "2026-10-20T09:00:00.000Z",
      end_datetime: "2026-10-20T12:00:00.000Z",
    };
    jest.spyOn(eventModel, "findUnassignedSubmittedEvents").mockResolvedValue([event]);
    const res = makeResponse();

    await eventController.getUnassignedEvents({}, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      events: [eventModel.toApi(event)],
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
    const users = chain({
      data: userRows,
      error: null,
    });
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
    const events = chain({
      data: eventRows,
      error: null,
    });
    supabase.from.mockImplementation((table) => (table === "user" ? users : events));
    users.order.mockResolvedValue({ data: userRows, error: null });
    events.order.mockResolvedValue({ data: eventRows, error: null });

    await expect(eventModel.findCoordinatorAvailability()).resolves.toEqual([
      expect.objectContaining({ coordinatorId: 7, name: "Alice Coordinator", events: expect.any(Array) }),
      expect.objectContaining({ coordinatorId: 8, name: "Bob Coordinator", events: [] }),
    ]);
    expect(users.eq).toHaveBeenNthCalledWith(1, "role", "COORDINATOR");
    expect(users.eq).toHaveBeenNthCalledWith(2, "is_active", true);
    expect(events.not).toHaveBeenCalledWith("coordinator_id", "is", null);
    expect(events.not).toHaveBeenCalledWith("status", "in", '("DRAFT","REJECTED","CANCELLED")');
    expect(events.order).toHaveBeenCalledWith("start_datetime", { ascending: true });
  });

  test("[SPM-174-AC3] rejects an assignment when the coordinator has an overlapping event", async () => {
    const event = chain({
      data: {
        event_id: 42,
        status: "SUBMITTED",
        coordinator_id: null,
        start_datetime: "2026-11-01T10:00:00.000Z",
        end_datetime: "2026-11-01T12:00:00.000Z",
      },
      error: null,
    });
    const coordinator = chain({
      data: { user_id: 7, name: "Alice Coordinator" },
      error: null,
    });
    const conflictsResult = [{ title: "Existing event", start_datetime: "2026-11-01T11:00:00.000Z", end_datetime: "2026-11-01T13:00:00.000Z" }];
    const conflicts = chain({ data: conflictsResult, error: null });
    conflicts.gt.mockResolvedValue({
      data: conflictsResult,
      error: null,
    });
    supabase.from
      .mockReturnValueOnce(event)
      .mockReturnValueOnce(coordinator)
      .mockReturnValueOnce(conflicts);

    await expect(eventModel.assignCoordinator({ eventId: 42, coordinatorId: 7 })).rejects.toMatchObject({
      name: "EventRequestError",
      code: "COORDINATOR_CONFLICT",
    });
    expect(conflicts.lt).toHaveBeenCalledWith("start_datetime", "2026-11-01T12:00:00.000Z");
    expect(conflicts.gt).toHaveBeenCalledWith("end_datetime", "2026-11-01T10:00:00.000Z");
    expect(supabase.from).toHaveBeenCalledTimes(3);
  });

  test("[SPM-174-AC3] allows an assignment when an existing event only touches a boundary", async () => {
    const event = chain({
      data: {
        event_id: 42,
        status: "SUBMITTED",
        coordinator_id: null,
        start_datetime: "2026-11-01T10:00:00.000Z",
        end_datetime: "2026-11-01T12:00:00.000Z",
      },
      error: null,
    });
    const coordinator = chain({
      data: { user_id: 7, name: "Alice Coordinator" },
      error: null,
    });
    const conflicts = chain({ data: [], error: null });
    conflicts.gt.mockResolvedValue({ data: [], error: null });
    const updated = {
      event_id: 42,
      status: "SUBMITTED",
      coordinator_id: 7,
      start_datetime: "2026-11-01T10:00:00.000Z",
      end_datetime: "2026-11-01T12:00:00.000Z",
    };
    const update = chain({ data: updated, error: null });
    supabase.from
      .mockReturnValueOnce(event)
      .mockReturnValueOnce(coordinator)
      .mockReturnValueOnce(conflicts)
      .mockReturnValueOnce(update);

    await expect(eventModel.assignCoordinator({ eventId: 42, coordinatorId: 7 })).resolves.toEqual(updated);
    expect(update.update).toHaveBeenCalledWith({ coordinator_id: 7 });
    expect(update.is).toHaveBeenCalledWith("coordinator_id", null);
  });

  test("[SPM-174-AC3] maps an invalid coordinator to a structured client error", async () => {
    const event = chain({
      data: { event_id: 42, status: "SUBMITTED", coordinator_id: null },
      error: null,
    });
    const coordinator = chain({ data: null, error: null });
    supabase.from.mockReturnValueOnce(event).mockReturnValueOnce(coordinator);
    const res = makeResponse();

    await eventController.assignCoordinator({ params: { id: "42" }, body: { coordinatorId: 999 } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Select an active Event Coordinator.",
      code: "INVALID_COORDINATOR",
    });
  });

  test("[SPM-174-AC2] rejects malformed assignment input before querying the database", async () => {
    const res = makeResponse();

    await eventController.assignCoordinator({ params: { id: "42" }, body: { coordinatorId: "7" } }, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Select an active Event Coordinator.",
      code: "INVALID_COORDINATOR",
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
