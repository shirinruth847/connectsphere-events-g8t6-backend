// SPM-286 / SPM-287 routes with the model mocked: access, validation and error
// mapping. The database rules are covered by
// tests/database/spm286287TechnicalRequests.test.cjs and the live integration test.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/equipmentModel", () => ({
  ...jest.requireActual("../../model/equipmentModel"),
  listEquipmentAvailability: jest.fn(),
  findAvailableQuantities: jest.fn(),
  requestTechnicalSupport: jest.fn(),
  listTechnicalRequests: jest.fn(),
  getTechnicalRequest: jest.fn(),
  decideTechnicalRequest: jest.fn(),
}));
jest.mock("../../model/eventModel", () => ({
  ...jest.requireActual("../../model/eventModel"),
  findVisibleEvent: jest.fn(),
  findValidationContext: jest.fn(),
  saveDraft: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const equipmentModel = require("../../model/equipmentModel");
const eventModel = require("../../model/eventModel");
const { USER_ROLES } = require("../../config/roles");
const { MESSAGES } = require("../../validators/equipmentValidator");

const USER_ID = 21;
const KEY = "5f0f2a7c-1d7e-4c8e-9a51-6b2f1c3d4e5f";
const equipmentError = (code, extra = {}) => Object.assign(new Error(code), { name: "EquipmentError", code, ...extra });

const signInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-user");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: USER_ID, role, organisation_ids: [] });
};

const send = (method, path, body, headers = {}) => {
  let req = request(app)[method](path).set("Authorization", "Bearer token");
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};

const planningEvent = { event_id: 42, organiser_id: 11, coordinator_id: USER_ID, organisation_id: null, status: "PLANNING", version: 3 };
const items = [{ equipmentId: 100, quantity: 4 }];

beforeEach(() => {
  jest.clearAllMocks();
  eventModel.findVisibleEvent.mockResolvedValue(planningEvent);
});

// ---------- SPM-286 catalogue options ----------

describe("GET /api/events/equipment-options (SPM-286 AC1/AC2)", () => {
  test.each(["ORGANISER", "COORDINATOR"])("[SPM-286-TC-01] %s gets availability for the window", async (role) => {
    signInAs(role);
    const options = { window: {}, note: null, equipment: [{ equipmentId: 100, availableQuantity: 8 }] };
    equipmentModel.listEquipmentAvailability.mockResolvedValue(options);

    const res = await send("get", "/api/events/equipment-options?start=2030-03-10T11:00:00Z&end=2030-03-10T13:00:00Z");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(options);
    expect(equipmentModel.listEquipmentAvailability).toHaveBeenCalledWith({
      start: "2030-03-10T11:00:00.000Z",
      end: "2030-03-10T13:00:00.000Z",
    });
  });

  test("[SPM-286-AC2] no window reads usable stock", async () => {
    signInAs("ORGANISER");
    equipmentModel.listEquipmentAvailability.mockResolvedValue({ window: null, note: "n", equipment: [] });
    expect((await send("get", "/api/events/equipment-options")).status).toBe(200);
    expect(equipmentModel.listEquipmentAvailability).toHaveBeenCalledWith({ start: null, end: null });
  });

  test.each([
    ["?start=2030-03-10T11:00:00Z", "end"],
    ["?start=2030-03-10T13:00:00Z&end=2030-03-10T11:00:00Z", "end"],
    ["?start=tomorrow&end=2030-03-10T11:00:00Z", "start"],
  ])("[SPM-286-AC1] an invalid window %s is a field error", async (query, field) => {
    signInAs("ORGANISER");
    const res = await send("get", `/api/events/equipment-options${query}`);
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields)).toEqual([field]);
    expect(equipmentModel.listEquipmentAvailability).not.toHaveBeenCalled();
  });

  test.each(Object.values(USER_ROLES).filter((role) => !["ORGANISER", "COORDINATOR"].includes(role)))(
    "[SPM-286-AC1] %s is refused",
    async (role) => {
      signInAs(role);
      expect((await send("get", "/api/events/equipment-options")).status).toBe(403);
    }
  );
});

// ---------- SPM-286 AC3: saved quantities are at most what is available ----------

describe("POST /api/events/drafts equipment quantities (SPM-286 AC3, TC-05)", () => {
  const draft = (quantity, times = { startDatetime: "2030-03-10T11:00:00Z", endDatetime: "2030-03-10T13:00:00Z" }) => ({
    title: "Gala", ...times, equipmentRequirements: [{ equipmentId: 100, quantity }],
  });

  beforeEach(() => {
    signInAs("ORGANISER");
    eventModel.findValidationContext.mockResolvedValue({ allowedLayouts: ["NO_PREFERENCE"], venueIds: [], equipmentIds: [100] });
    eventModel.saveDraft.mockResolvedValue({ event: { event_id: 42, organiser_id: USER_ID, status: "DRAFT", title: "Gala", updated_at: "2030-01-01T00:00:00Z" }, replayed: false });
    equipmentModel.findAvailableQuantities.mockResolvedValue(new Map([[100, { name: "Wireless Mic", availableQuantity: 8 }]]));
  });

  test("[SPM-286-TC-05] above the available quantity is a field error; nothing is saved", async () => {
    const res = await send("post", "/api/events/drafts", draft(9), { "Idempotency-Key": KEY });
    expect(res.status).toBe(400);
    expect(res.body.fields.equipmentRequirements).toBe("Not enough equipment for the event's date and time: Wireless Mic (8 available).");
    expect(equipmentModel.findAvailableQuantities).toHaveBeenCalledWith([100], { start: "2030-03-10T11:00:00.000Z", end: "2030-03-10T13:00:00.000Z" });
    expect(eventModel.saveDraft).not.toHaveBeenCalled();
  });

  test("[SPM-286-TC-03] the available quantity is saved", async () => {
    expect((await send("post", "/api/events/drafts", draft(8), { "Idempotency-Key": KEY })).status).toBe(201);
    expect(eventModel.saveDraft).toHaveBeenCalled();
  });

  test("[SPM-286-AC2] without a date and time nothing is checked yet", async () => {
    expect((await send("post", "/api/events/drafts", draft(50, {}), { "Idempotency-Key": KEY })).status).toBe(201);
    expect(equipmentModel.findAvailableQuantities).not.toHaveBeenCalled();
  });
});

// ---------- SPM-286 coordinator sends the technical request ----------

describe("POST /api/events/:id/technical-requests (SPM-286 AC5-AC7)", () => {
  const path = "/api/events/42/technical-requests";

  test("[SPM-286-TC-06] the assigned coordinator sends it: 201 PENDING", async () => {
    signInAs("COORDINATOR");
    equipmentModel.requestTechnicalSupport.mockResolvedValue({ technicalRequestId: 5, status: "PENDING", replayed: false });

    const res = await send("post", path, { items }, { "Idempotency-Key": KEY });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ technicalRequestId: 5, status: "PENDING" });
    expect(equipmentModel.requestTechnicalSupport).toHaveBeenCalledWith({ actorId: USER_ID, eventId: 42, items, idempotencyKey: KEY });
  });

  test("[SPM-286-TC-09] a replay answers 200 with Idempotent-Replayed", async () => {
    signInAs("COORDINATOR");
    equipmentModel.requestTechnicalSupport.mockResolvedValue({ technicalRequestId: 5, status: "PENDING", replayed: true });
    const res = await send("post", path, { items }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });

  test.each([
    [[{ equipmentId: 100, quantity: 0 }], "items[0].quantity"],
    [[{ equipmentId: 100, quantity: 1.5 }], "items[0].quantity"],
    [[{ equipmentId: 100, quantity: "2" }], "items[0].quantity"],
    [[{ equipmentId: 100, quantity: 1 }, { equipmentId: 100, quantity: 2 }], "items[1].equipmentId"],
    [[{ equipmentId: "abc", quantity: 1 }], "items[0].equipmentId"],
    [[], "items"],
  ])("[SPM-286-TC-05][SPM-286-AC7] %j is a field error and nothing is sent", async (body, field) => {
    signInAs("COORDINATOR");
    const res = await send("post", path, { items: body }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty([field]);
    expect(equipmentModel.requestTechnicalSupport).not.toHaveBeenCalled();
  });

  test("[SPM-286-AC7] the Idempotency-Key header is required", async () => {
    signInAs("COORDINATOR");
    const res = await send("post", path, { items });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("idempotencyKey");
  });

  test("[SPM-286-AC6][SPM-286-TC-08] too little stock: 409 naming the available quantity", async () => {
    signInAs("COORDINATOR");
    equipmentModel.requestTechnicalSupport.mockRejectedValue(
      equipmentError("EQUIPMENT_NOT_AVAILABLE", { detail: { items: [{ equipmentId: 100, name: "Wireless Mic", requested: 4, available: 2 }] } })
    );
    const res = await send("post", path, { items }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EQUIPMENT_NOT_AVAILABLE");
    expect(res.body.error).toBe("Not enough equipment for the event's time: Wireless Mic (4 requested, 2 available).");
    expect(res.body.items[0].available).toBe(2);
  });

  test.each([
    ["EVENT_NOT_IN_PLANNING", 409],
    ["TECHNICAL_REQUEST_EXISTS", 409],
    ["IDEMPOTENCY_KEY_REUSED", 409],
    ["FORBIDDEN", 403],
  ])("[SPM-286-TC-07] %s maps to %s", async (code, status) => {
    signInAs("COORDINATOR");
    equipmentModel.requestTechnicalSupport.mockRejectedValue(equipmentError(code));
    const res = await send("post", path, { items }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  test("[SPM-286-AC7] an unknown item is a field error", async () => {
    signInAs("COORDINATOR");
    equipmentModel.requestTechnicalSupport.mockRejectedValue(equipmentError("UNKNOWN_EQUIPMENT", { detail: { equipmentIds: [100] } }));
    const res = await send("post", path, { items }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ items: MESSAGES.unknownEquipment });
  });

  test.each(["ORGANISER", "TECH_SUPPORT", "VENUE_STAFF"])("[SPM-286-AC5] %s cannot send one", async (role) => {
    signInAs(role);
    expect((await send("post", path, { items }, { "Idempotency-Key": KEY })).status).toBe(403);
    expect(equipmentModel.requestTechnicalSupport).not.toHaveBeenCalled();
  });

  test("[SPM-286-AC5] another coordinator gets not found", async () => {
    signInAs("COORDINATOR");
    eventModel.findVisibleEvent.mockResolvedValue(null);
    expect((await send("post", path, { items }, { "Idempotency-Key": KEY })).status).toBe(404);
    expect(equipmentModel.requestTechnicalSupport).not.toHaveBeenCalled();
  });
});

// ---------- SPM-287 dashboard ----------

const DASHBOARD_ROUTES = [
  ["get", "/api/equipment/requests"],
  ["get", "/api/equipment/requests/5"],
  ["post", "/api/equipment/requests/5/decision"],
];

describe("SPM-287 access (AC6, TC-07)", () => {
  const cases = Object.values(USER_ROLES)
    .filter((role) => role !== USER_ROLES.TECH_SUPPORT)
    .flatMap((role) => DASHBOARD_ROUTES.map(([method, path]) => [role, method, path]));
  test.each(cases)("[SPM-287-TC-07] %s: %s %s is 403", async (role, method, path) => {
    signInAs(role);
    const res = await send(method, path, { decision: "APPROVE" }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(403);
    expect(equipmentModel.listTechnicalRequests).not.toHaveBeenCalled();
    expect(equipmentModel.getTechnicalRequest).not.toHaveBeenCalled();
    expect(equipmentModel.decideTechnicalRequest).not.toHaveBeenCalled();
  });
});

describe("GET /api/equipment/requests (SPM-287 AC1/AC2)", () => {
  test("[SPM-287-TC-02] status filter and search reach the model", async () => {
    signInAs("TECH_SUPPORT");
    equipmentModel.listTechnicalRequests.mockResolvedValue({ technicalRequests: [], total: 0, nextOffset: null });
    const res = await send("get", "/api/equipment/requests?status=APPROVED&search=%20Gala%20");
    expect(res.status).toBe(200);
    expect(equipmentModel.listTechnicalRequests).toHaveBeenCalledWith({ status: "APPROVED", search: "Gala" }, expect.objectContaining({ offset: 0 }));
  });

  test("[SPM-287-AC2] an unknown status is a field error", async () => {
    signInAs("TECH_SUPPORT");
    const res = await send("get", "/api/equipment/requests?status=PARTIALLY_FULFILLED");
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ status: MESSAGES.requestStatusInvalid });
  });
});

describe("GET /api/equipment/requests/:requestId (SPM-287 AC3)", () => {
  test("[SPM-287-TC-03] returns the request", async () => {
    signInAs("TECH_SUPPORT");
    equipmentModel.getTechnicalRequest.mockResolvedValue({ technicalRequestId: 5, items: [], history: [] });
    const res = await send("get", "/api/equipment/requests/5");
    expect(res.status).toBe(200);
    expect(equipmentModel.getTechnicalRequest).toHaveBeenCalledWith(5);
  });

  test.each(["0", "abc"])("[SPM-287-AC3] id %s or a missing request is 404", async (id) => {
    signInAs("TECH_SUPPORT");
    equipmentModel.getTechnicalRequest.mockResolvedValue(null);
    expect((await send("get", `/api/equipment/requests/${id}`)).status).toBe(404);
    expect((await send("get", "/api/equipment/requests/77")).status).toBe(404);
  });
});

describe("POST /api/equipment/requests/:requestId/decision (SPM-287 AC4-AC7)", () => {
  const path = "/api/equipment/requests/5/decision";

  test("[SPM-287-TC-04] approve", async () => {
    signInAs("TECH_SUPPORT");
    equipmentModel.decideTechnicalRequest.mockResolvedValue({ technicalRequestId: 5, status: "APPROVED", replayed: false });
    const res = await send("post", path, { decision: "APPROVE", reason: "ignored" }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(200);
    expect(equipmentModel.decideTechnicalRequest).toHaveBeenCalledWith({
      actorId: USER_ID, requestId: 5, decision: "APPROVE", reason: null, idempotencyKey: KEY,
    });
  });

  test("[SPM-287-TC-05] reject with a trimmed reason", async () => {
    signInAs("TECH_SUPPORT");
    equipmentModel.decideTechnicalRequest.mockResolvedValue({ technicalRequestId: 5, status: "REJECTED", replayed: false });
    await send("post", path, { decision: "REJECT", reason: "  Projector unavailable " }, { "Idempotency-Key": KEY });
    expect(equipmentModel.decideTechnicalRequest).toHaveBeenCalledWith(expect.objectContaining({ reason: "Projector unavailable" }));
  });

  test.each([
    [{ decision: "REJECT" }, "reason", MESSAGES.rejectionReasonRequired],
    [{ decision: "REJECT", reason: "   " }, "reason", MESSAGES.rejectionReasonRequired],
    [{ decision: "REJECT", reason: "x".repeat(1001) }, "reason", MESSAGES.rejectionReasonTooLong],
    [{ decision: "MAYBE" }, "decision", MESSAGES.decisionInvalid],
  ])("[SPM-287-TC-06] %j is blocked", async (body, field, message) => {
    signInAs("TECH_SUPPORT");
    const res = await send("post", path, body, { "Idempotency-Key": KEY });
    expect(res.status).toBe(400);
    expect(res.body.fields[field]).toBe(message);
    expect(equipmentModel.decideTechnicalRequest).not.toHaveBeenCalled();
  });

  test("[SPM-287-TC-08][SPM-287-TC-09] already decided: 409 with the current status", async () => {
    signInAs("TECH_SUPPORT");
    equipmentModel.decideTechnicalRequest.mockRejectedValue(equipmentError("TECHNICAL_REQUEST_ALREADY_DECIDED", { detail: { status: "APPROVED" } }));
    const res = await send("post", path, { decision: "APPROVE" }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "TECHNICAL_REQUEST_ALREADY_DECIDED", status: "APPROVED" });
  });

  test("[SPM-287-TC-10] a replayed approval answers 200 with Idempotent-Replayed", async () => {
    signInAs("TECH_SUPPORT");
    equipmentModel.decideTechnicalRequest.mockResolvedValue({ technicalRequestId: 5, status: "APPROVED", replayed: true });
    const res = await send("post", path, { decision: "APPROVE" }, { "Idempotency-Key": KEY });
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.body.replayed).toBeUndefined();
  });

  test("[SPM-287-AC7] the Idempotency-Key header is required", async () => {
    signInAs("TECH_SUPPORT");
    const res = await send("post", path, { decision: "APPROVE" });
    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("idempotencyKey");
  });
});
