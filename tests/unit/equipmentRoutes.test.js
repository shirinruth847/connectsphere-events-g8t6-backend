// SPM-52 routes with the model mocked: access, validation and error mapping.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn(), auth: {} }));
jest.mock("../../model/userModel");
jest.mock("../../model/equipmentModel", () => ({
  listEquipment: jest.fn(),
  listEquipmentCategories: jest.fn(),
  getEquipment: jest.fn(),
  findEquipmentSummary: jest.fn(),
  findUnavailabilityRow: jest.fn(),
  createEquipment: jest.fn(),
  updateEquipment: jest.fn(),
  setEquipmentActive: jest.fn(),
  recordUnavailability: jest.fn(),
  updateUnavailability: jest.fn(),
  endUnavailability: jest.fn(),
}));

const request = require("supertest");
const app = require("../../server");
const userModel = require("../../model/userModel");
const equipmentModel = require("../../model/equipmentModel");
const { USER_ROLES } = require("../../config/roles");
const { MESSAGES } = require("../../validators/equipmentValidator");

const TECH_ID = 41;
const equipmentError = (code, extra = {}) => Object.assign(new Error(code), { name: "EquipmentError", code, ...extra });

const projector = { name: "Laser Projector", category: "Visual", storageLocation: "Store Room B", totalQuantity: 4 };
const saved = { equipmentId: 9, ...projector, status: "DETAILS_PENDING", version: 1 };
const period = { quantity: 3, reason: "DAMAGED", startsAt: "2031-01-06T09:00:00Z", endsAt: "2031-01-06T10:00:00Z", note: "Cracked lens" };

const as = (method, path) => request(app)[method](path).set("Authorization", "Bearer token");
const signInAs = (role) => {
  userModel.verifyAccessToken.mockResolvedValue("auth-user");
  userModel.findUserByAuthId.mockResolvedValue({ user_id: TECH_ID, role, organisation_ids: [] });
};

const ROUTES = [
  ["get", "/api/equipment"],
  ["get", "/api/equipment/options"],
  ["get", "/api/equipment/9"],
  ["post", "/api/equipment"],
  ["put", "/api/equipment/9"],
  ["put", "/api/equipment/9/status"],
  ["post", "/api/equipment/9/unavailability"],
  ["put", "/api/equipment/9/unavailability/3"],
  ["post", "/api/equipment/9/unavailability/3/end"],
];
const OTHER_ROLES = Object.values(USER_ROLES).filter((role) => role !== USER_ROLES.TECH_SUPPORT);

beforeEach(() => {
  jest.clearAllMocks();
  signInAs("TECH_SUPPORT");
});

describe("SPM-52 access", () => {
  test.each(ROUTES)("[AC1] should_return_401_without_a_session_for_%s_%s", async (method, path) => {
    const response = await request(app)[method](path).send(projector);

    expect(response.status).toBe(401);
    Object.values(equipmentModel).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  const cases = OTHER_ROLES.flatMap((role) => ROUTES.map(([method, path]) => [role, method, path]));
  test.each(cases)("[TC-05] should_return_403_for_%s_on_%s_%s", async (role, method, path) => {
    signInAs(role);

    const response = await as(method, path).send(projector);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
    Object.values(equipmentModel).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  test("[AC1] should_answer_403_when_the_database_refuses_the_role", async () => {
    equipmentModel.createEquipment.mockRejectedValue(equipmentError("FORBIDDEN"));

    const response = await as("post", "/api/equipment").send(projector);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("FORBIDDEN");
  });
});

describe("SPM-52 catalogue", () => {
  test("[TC-16] should_pass_filters_and_pagination_to_the_model", async () => {
    equipmentModel.listEquipment.mockResolvedValue({ equipment: [], nextOffset: null });

    const response = await as("get", "/api/equipment?search=MIC&category=Audio&status=INACTIVE&limit=20");

    expect(response.status).toBe(200);
    expect(equipmentModel.listEquipment).toHaveBeenCalledWith(
      { search: "MIC", category: "Audio", status: "INACTIVE" },
      { limit: 20, offset: 0 }
    );
  });

  test("[AC5] should_refuse_an_unknown_status_filter_with_400", async () => {
    const response = await as("get", "/api/equipment?status=BROKEN");

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ status: MESSAGES.statusInvalid });
  });

  test("[AC5] should_answer_404_for_an_unknown_or_impossible_id", async () => {
    equipmentModel.getEquipment.mockResolvedValue(null);

    expect((await as("get", "/api/equipment/9")).status).toBe(404);
    expect((await as("get", "/api/equipment/abc")).status).toBe(404);
    expect(equipmentModel.getEquipment).toHaveBeenCalledTimes(1);
  });

  test("[TC-01] should_create_with_the_signed_in_actor_and_answer_201", async () => {
    equipmentModel.createEquipment.mockResolvedValue({ equipment: saved });

    const response = await as("post", "/api/equipment").send({ ...projector, specifications: "4K" });

    expect(response.status).toBe(201);
    expect(response.body.equipment).toEqual(saved);
    expect(equipmentModel.createEquipment).toHaveBeenCalledWith(TECH_ID, expect.objectContaining({ name: "Laser Projector", specifications: "4K" }));
  });

  test("[TC-02] should_answer_400_with_field_messages_and_create_nothing", async () => {
    const response = await as("post", "/api/equipment").send({ ...projector, name: "", totalQuantity: "" });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ name: "Name is required", totalQuantity: "Total quantity is required" });
    expect(equipmentModel.createEquipment).not.toHaveBeenCalled();
  });

  test("[TC-04] should_answer_409_with_the_name_message_when_the_name_is_taken", async () => {
    equipmentModel.createEquipment.mockRejectedValue(equipmentError("EQUIPMENT_NAME_TAKEN"));

    const response = await as("post", "/api/equipment").send({ ...projector, name: "wireless microphone" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "EQUIPMENT_NAME_TAKEN", fields: { name: "Equipment with this name already exists" } });
  });

  test("[TC-07] should_answer_409_with_the_current_values_when_the_version_is_stale", async () => {
    const current = { ...saved, storageLocation: "Store Room C", version: 3 };
    equipmentModel.updateEquipment.mockRejectedValue(equipmentError("EQUIPMENT_VERSION_CONFLICT"));
    equipmentModel.findEquipmentSummary.mockResolvedValue(current);

    const response = await as("put", "/api/equipment/9").send({ storageLocation: "Store Room D", version: 2 });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "EQUIPMENT_VERSION_CONFLICT", current });
  });

  test("[TC-08] should_name_the_committed_quantity_and_period_when_lowering_the_total", async () => {
    equipmentModel.updateEquipment.mockRejectedValue(equipmentError("EQUIPMENT_QUANTITY_COMMITTED", {
      detail: { committedQuantity: 3, periodStart: "2031-01-06T09:00:00+00:00", periodEnd: "2031-01-06T10:00:00+00:00" },
    }));

    const response = await as("put", "/api/equipment/9").send({ totalQuantity: 2, version: 1 });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "EQUIPMENT_QUANTITY_COMMITTED", committedQuantity: 3 });
    expect(response.body.error).toContain("3 units are unavailable from 2031-01-06T09:00:00+00:00 to 2031-01-06T10:00:00+00:00");
    expect(response.body.fields.totalQuantity).toBe(response.body.error);
  });

  test("[TC-11] should_list_the_upcoming_events_until_deactivation_is_confirmed", async () => {
    const upcomingEvents = [{ eventId: 436, requestId: "REQ-000436", title: "Product launch", startDatetime: "2026-11-08T02:00:00+00:00" }];
    equipmentModel.setEquipmentActive.mockRejectedValueOnce(equipmentError("EQUIPMENT_HAS_UPCOMING_REQUESTS", { detail: { upcomingCount: 1, upcomingEvents } }));

    const warned = await as("put", "/api/equipment/9/status").send({ active: false, version: 2 });

    expect(warned.status).toBe(409);
    expect(warned.body).toMatchObject({ code: "EQUIPMENT_HAS_UPCOMING_REQUESTS", upcomingCount: 1, upcomingEvents });

    equipmentModel.setEquipmentActive.mockResolvedValueOnce({ equipment: { ...saved, isActive: false }, changed: true, upcomingRequests: 1 });
    const confirmed = await as("put", "/api/equipment/9/status").send({ active: false, version: 2, confirmUpcomingRequests: true });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ message: "Equipment deactivated.", changed: true, upcomingRequests: 1 });
    expect(equipmentModel.setEquipmentActive).toHaveBeenLastCalledWith(TECH_ID, 9, { active: false, version: 2, confirmUpcomingRequests: true });
  });
});

describe("SPM-52 unavailable stock", () => {
  test("[AC8] should_record_a_period_and_answer_201", async () => {
    equipmentModel.recordUnavailability.mockResolvedValue({ unavailability: { unavailabilityId: 3 }, equipment: saved, changed: true });

    const response = await as("post", "/api/equipment/9/unavailability").send(period);

    expect(response.status).toBe(201);
    expect(equipmentModel.recordUnavailability).toHaveBeenCalledWith(TECH_ID, 9, {
      quantity: 3,
      reason: "DAMAGED",
      starts_at: "2031-01-06T09:00:00.000Z",
      ends_at: "2031-01-06T10:00:00.000Z",
      note: "Cracked lens",
    });
  });

  test("[TC-10] should_refuse_more_than_the_stock_with_the_available_quantity", async () => {
    equipmentModel.recordUnavailability.mockRejectedValue(equipmentError("EQUIPMENT_STOCK_EXCEEDED", {
      detail: { availableQuantity: 5, periodStart: "2031-01-06T12:00:00+00:00", periodEnd: "2031-01-06T13:00:00+00:00" },
    }));

    const response = await as("post", "/api/equipment/9/unavailability").send({ ...period, quantity: 6 });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "EQUIPMENT_STOCK_EXCEEDED", availableQuantity: 5 });
    expect(response.body.fields.quantity).toContain("Only 5 units are left");
  });

  test("[TC-10] should_refuse_an_end_before_the_start_without_calling_the_model", async () => {
    const response = await as("post", "/api/equipment/9/unavailability").send({ ...period, endsAt: "2031-01-06T08:00:00Z" });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ endsAt: MESSAGES.endBeforeStart });
    expect(equipmentModel.recordUnavailability).not.toHaveBeenCalled();
  });

  test("[AC8] should_answer_404_when_the_record_belongs_to_another_item", async () => {
    equipmentModel.findUnavailabilityRow.mockResolvedValue(null);

    const response = await as("put", "/api/equipment/9/unavailability/3").send({ note: "x", version: 1 });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("UNAVAILABILITY_NOT_FOUND");
  });

  test("[AC8] should_answer_409_when_an_ended_record_is_changed", async () => {
    equipmentModel.endUnavailability.mockRejectedValue(equipmentError("UNAVAILABILITY_ENDED"));

    const response = await as("post", "/api/equipment/9/unavailability/3/end").send({ version: 2 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("UNAVAILABILITY_ENDED");
  });

  test("[AC8] should_say_cancelled_when_a_future_record_is_ended", async () => {
    equipmentModel.endUnavailability.mockResolvedValue({ unavailability: { unavailabilityId: 3, status: "CANCELLED" }, equipment: saved, changed: true });

    const response = await as("post", "/api/equipment/9/unavailability/3/end").send({ version: 1 });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Unavailable stock cancelled.");
  });
});
