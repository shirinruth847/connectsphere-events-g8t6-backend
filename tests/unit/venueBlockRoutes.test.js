// SPM-195 routes: Venue Staff only, validation, Idempotency-Key and the error
// mapping. The model is mocked; tests/unit/venueBlockModel.test.js covers it.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/venueModel", () => ({
  listVenueBlocks: jest.fn(),
  createVenueBlock: jest.fn(),
  changeVenueBlock: jest.fn(),
  restoreVenueIncident: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const venueModel = require("../../model/venueModel");

const VENUE_STAFF_ID = 30;
const BLOCK_ID = "a".repeat(24);
const venueError = (code, extra = {}) => Object.assign(new Error(code), { name: "VenueError", code, ...extra });

const signedInAs = (userId, role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-uuid");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: userId, role, organisation_ids: [] });
};
const send = (method, path, body, key = "spm195-request-0001") => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  if (key) req = req.set("Idempotency-Key", key);
  return body === undefined ? req : req.send(body);
};
const blockBody = (overrides = {}) => ({
  reason: "MAINTENANCE",
  start: "2030-03-10T13:00:00+08:00",
  end: "2030-03-10T15:00:00+08:00",
  note: "Air conditioning repair",
  ...overrides,
});
const savedBlock = (overrides = {}) => ({
  block: { blockId: BLOCK_ID, venueId: 7, reason: "MAINTENANCE", status: "ACTIVE", version: 1 },
  incidents: [{ incidentId: 1, eventId: 42, bookingId: 900, calendarHoldId: null, requestId: "REQ-000042" }],
  affectedEvents: [{ eventId: 42, requestId: "REQ-000042" }],
  replayed: false,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  signedInAs(VENUE_STAFF_ID, "VENUE_STAFF");
});

describe("Venue Staff only (SPM-195 AC1, TC-03)", () => {
  const calls = [
    ["get", "/api/venues/7/blocks", undefined],
    ["post", "/api/venues/7/blocks", blockBody()],
    ["put", `/api/venues/7/blocks/${BLOCK_ID}`, { start: blockBody().start, end: blockBody().end, version: 1 }],
    ["post", `/api/venues/7/blocks/${BLOCK_ID}/lift`, { version: 1 }],
    ["post", "/api/venues/incidents/5/restore", undefined],
  ];
  const otherRoles = ["ORGANISER", "COORDINATOR_LEAD", "COORDINATOR", "TECH_SUPPORT", "SAFETY_OFFICER", "ATTENDEE"];

  test.each(otherRoles)("[SPM-195-AC1] should_refuse_every_block_route_for_%s", async (role) => {
    signedInAs(99, role);
    for (const [method, path, body] of calls) {
      const response = await send(method, path, body);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("FORBIDDEN");
    }
    expect(venueModel.createVenueBlock).not.toHaveBeenCalled();
    expect(venueModel.changeVenueBlock).not.toHaveBeenCalled();
    expect(venueModel.restoreVenueIncident).not.toHaveBeenCalled();
  });

  test("should_require_sign_in", async () => {
    const response = await request(app).post("/api/venues/7/blocks").send(blockBody());
    expect(response.status).toBe(401);
  });
});

describe("POST /api/venues/:venueId/blocks", () => {
  test("[SPM-195-AC2] should_record_a_block_and_answer_201", async () => {
    venueModel.createVenueBlock.mockResolvedValue(savedBlock());
    const response = await send("post", "/api/venues/7/blocks", blockBody());
    expect(response.status).toBe(201);
    expect(response.body.message).toMatch(/One booking or hold is affected/);
    expect(venueModel.createVenueBlock).toHaveBeenCalledWith({
      actorId: VENUE_STAFF_ID,
      venueId: 7,
      idempotencyKey: "spm195-request-0001",
      block: {
        reason: "MAINTENANCE",
        start: "2030-03-10T05:00:00.000Z",
        end: "2030-03-10T07:00:00.000Z",
        note: "Air conditioning repair",
      },
    });
  });

  test("[SPM-195-AC13] should_answer_200_for_a_replay", async () => {
    venueModel.createVenueBlock.mockResolvedValue(savedBlock({ replayed: true, incidents: [] }));
    const response = await send("post", "/api/venues/7/blocks", blockBody());
    expect(response.status).toBe(200);
    expect(response.body.message).toMatch(/No bookings or holds are affected/);
  });

  test("should_count_several_affected_bookings_and_holds", async () => {
    venueModel.createVenueBlock.mockResolvedValue(savedBlock({ incidents: [{ incidentId: 1 }, { incidentId: 2 }] }));
    const response = await send("post", "/api/venues/7/blocks", blockBody());
    expect(response.body.message).toBe("Block recorded. 2 bookings or holds are affected; their coordinators have been told.");
  });

  test("[SPM-195-TC-02] should_refuse_missing_and_invalid_fields_without_saving", async () => {
    const response = await send("post", "/api/venues/7/blocks", {
      reason: "", note: " ", start: "2030-03-10T15:00:00+08:00", end: "2030-03-10T13:00:00+08:00", status: "LIFTED",
    }, null);
    expect(response.status).toBe(400);
    expect(Object.keys(response.body.fields).sort()).toEqual(["end", "idempotencyKey", "note", "reason", "status"]);
    expect(venueModel.createVenueBlock).not.toHaveBeenCalled();
  });

  test("[SPM-195-TC-02] should_refuse_an_end_in_the_past", async () => {
    const response = await send("post", "/api/venues/7/blocks", blockBody({
      start: "2020-01-01T09:00:00+08:00", end: "2020-01-01T10:00:00+08:00",
    }));
    expect(response.status).toBe(400);
    expect(response.body.fields.end).toBe("The end must be in the future.");
  });

  test("should_answer_404_for_a_venue_id_that_cannot_exist", async () => {
    const response = await send("post", "/api/venues/abc/blocks", blockBody());
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("VENUE_NOT_FOUND");
  });

  test.each([
    ["VENUE_NOT_FOUND", 404],
    ["VENUE_LOCK_TIMEOUT", 409],
    ["IDEMPOTENCY_KEY_REUSED", 409],
    ["VENUE_CALENDAR_UNAVAILABLE", 503],
    ["VENUE_BOOKINGS_UNAVAILABLE", 503],
  ])("should_map_%s_to_%i", async (code, status) => {
    venueModel.createVenueBlock.mockRejectedValue(venueError(code));
    const response = await send("post", "/api/venues/7/blocks", blockBody());
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
  });

  test("should_hide_unexpected_errors", async () => {
    venueModel.createVenueBlock.mockRejectedValue(new Error("connection string leaked"));
    const response = await send("post", "/api/venues/7/blocks", blockBody());
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/leaked/);
  });
});

describe("shorten and lift (SPM-195 AC9)", () => {
  test("should_pass_the_new_range_and_version", async () => {
    venueModel.changeVenueBlock.mockResolvedValue({ block: { blockId: BLOCK_ID }, incidents: [], changed: true });
    const response = await send("put", `/api/venues/7/blocks/${BLOCK_ID}`, {
      start: "2030-03-10T13:00:00+08:00", end: "2030-03-10T14:00:00+08:00", version: 2,
    });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Block shortened.");
    expect(venueModel.changeVenueBlock).toHaveBeenCalledWith({
      actorId: VENUE_STAFF_ID, venueId: 7, blockId: BLOCK_ID,
      change: { start: "2030-03-10T05:00:00.000Z", end: "2030-03-10T06:00:00.000Z", version: 2 },
    });
  });

  test("[SPM-195-TC-13] should_refuse_lengthening_with_the_new_block_message", async () => {
    venueModel.changeVenueBlock.mockRejectedValue(venueError("BLOCK_CANNOT_BE_EXTENDED"));
    const response = await send("put", `/api/venues/7/blocks/${BLOCK_ID}`, {
      start: "2030-03-10T13:00:00+08:00", end: "2030-03-10T16:00:00+08:00", version: 1,
    });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("Record a new block for additional time.");
    expect(response.body.fields.end).toBe("Record a new block for additional time.");
  });

  test("should_refuse_a_shorten_without_a_version", async () => {
    const response = await send("put", `/api/venues/7/blocks/${BLOCK_ID}`, {
      start: "2030-03-10T13:00:00+08:00", end: "2030-03-10T14:00:00+08:00",
    });
    expect(response.status).toBe(400);
    expect(response.body.fields.version).toBeDefined();
  });

  test("should_answer_404_for_a_block_id_that_cannot_exist", async () => {
    const response = await send("post", "/api/venues/7/blocks/not-an-id/lift", { version: 1 });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("BLOCK_NOT_FOUND");
  });

  test("should_lift_and_report_an_unchanged_repeat", async () => {
    venueModel.changeVenueBlock.mockResolvedValue({ block: { blockId: BLOCK_ID, status: "LIFTED" }, incidents: [], changed: false });
    const response = await send("post", `/api/venues/7/blocks/${BLOCK_ID}/lift`, { version: 1 });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("No change: the block already matches.");
    expect(venueModel.changeVenueBlock).toHaveBeenCalledWith({
      actorId: VENUE_STAFF_ID, venueId: 7, blockId: BLOCK_ID, lift: { version: 1 },
    });
  });

  test.each([["BLOCK_VERSION_CONFLICT", 409], ["BLOCK_NOT_ACTIVE", 409], ["BLOCK_NOT_FOUND", 404]])(
    "should_map_%s_to_%i",
    async (code, status) => {
      venueModel.changeVenueBlock.mockRejectedValue(venueError(code));
      const response = await send("post", `/api/venues/7/blocks/${BLOCK_ID}/lift`, { version: 1 });
      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
    }
  );
});

describe("POST /api/venues/incidents/:incidentId/restore (SPM-195 AC10)", () => {
  test("should_restore_with_an_idempotency_key", async () => {
    venueModel.restoreVenueIncident.mockResolvedValue({ incidentId: 5, status: "RESOLVED", resolution: "RESTORED", changed: true });
    const response = await send("post", "/api/venues/incidents/5/restore");
    expect(response.status).toBe(200);
    expect(response.body.message).toMatch(/Booking restored/);
    expect(venueModel.restoreVenueIncident).toHaveBeenCalledWith({
      actorId: VENUE_STAFF_ID, incidentId: 5, idempotencyKey: "spm195-request-0001",
    });
  });

  test("[SPM-195-TC-17] should_report_an_already_restored_incident_unchanged", async () => {
    venueModel.restoreVenueIncident.mockResolvedValue({ incidentId: 5, status: "RESOLVED", changed: false, replayed: true });
    const response = await send("post", "/api/venues/incidents/5/restore");
    expect(response.status).toBe(200);
    expect(response.body.message).toBe("This booking was already restored.");
  });

  test("should_require_an_idempotency_key", async () => {
    const response = await send("post", "/api/venues/incidents/5/restore", undefined, null);
    expect(response.status).toBe(400);
    expect(response.body.fields.idempotencyKey).toBeDefined();
  });

  test("[SPM-195-TC-12] should_refuse_while_the_range_is_still_blocked", async () => {
    venueModel.restoreVenueIncident.mockRejectedValue(venueError("INCIDENT_STILL_BLOCKED", {
      blocks: [{ start: "2030-03-10T05:00:00.000Z", end: "2030-03-10T06:30:00.000Z", reasonLabel: "Maintenance" }],
    }));
    const response = await send("post", "/api/venues/incidents/5/restore");
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("INCIDENT_STILL_BLOCKED");
    expect(response.body.blocks).toHaveLength(1);
  });

  test.each([["INCIDENT_NOT_FOUND", 404], ["INCIDENT_NOT_RESTORABLE", 409], ["VENUE_OUT_OF_SERVICE", 409]])(
    "should_map_%s_to_%i",
    async (code, status) => {
      venueModel.restoreVenueIncident.mockRejectedValue(venueError(code));
      const response = await send("post", "/api/venues/incidents/5/restore");
      expect(response.status).toBe(status);
    }
  );

  test("should_answer_404_for_an_incident_id_that_cannot_exist", async () => {
    const response = await send("post", "/api/venues/incidents/0/restore");
    expect(response.status).toBe(404);
    expect(venueModel.restoreVenueIncident).not.toHaveBeenCalled();
  });
});
