jest.mock("../config/supabase", () => ({
  from: jest.fn(),
}));

const supabase = require("../config/supabase");
const eventModel = require("../model/eventModel");
const eventController = require("../controller/eventController");
const { requireRole } = require("../middleware/auth");
const { USER_ROLES } = require("../config/eventConstants");

const makeResponse = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
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
      message: "You do not have permission to perform this action.",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
