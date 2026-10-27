// SPM-52 equipment model reads with the database mocked.
jest.mock("../../config/supabase", () => ({ from: jest.fn(), rpc: jest.fn() }));
jest.mock("../../model/outboxModel", () => ({ findLatestPayload: jest.fn(), findUnappliedDocuments: jest.fn() }));
jest.mock("../../model/equipmentDetailModel", () => ({ getEquipmentDetail: jest.fn() }));

const supabase = require("../../config/supabase");
const outboxModel = require("../../model/outboxModel");
const equipmentModel = require("../../model/equipmentModel");

beforeEach(() => jest.clearAllMocks());

describe("SPM-52 equipment options", () => {
  test("[AC5] should_list_categories_once_in_any_letter_case_with_the_backend_status_and_reason_labels", async () => {
    supabase.from.mockReturnValue({
      select: jest.fn().mockResolvedValue({ data: [{ category: "Visual" }, { category: "audio" }, { category: "Audio" }], error: null }),
    });

    await expect(equipmentModel.listEquipmentOptions()).resolves.toEqual({
      categories: ["audio", "Visual"],
      statuses: [
        { value: "ACTIVE", label: "Active" },
        { value: "INACTIVE", label: "Inactive" },
        { value: "DETAILS_PENDING", label: "Details pending" },
      ],
      unavailabilityReasons: [
        { value: "DAMAGED", label: "Damaged or faulty" },
        { value: "MAINTENANCE", label: "Maintenance" },
        { value: "OTHER", label: "Other" },
      ],
    });
  });
});

describe("SPM-52 current details", () => {
  test("[TC-07] should_return_the_detail_fields_postgresql_last_wrote", async () => {
    outboxModel.findLatestPayload.mockResolvedValue({ name: "Mixer", category: "Audio", specifications: "16 channels", technicalNotes: null });

    await expect(equipmentModel.findCurrentDetails(41)).resolves.toEqual({ specifications: "16 channels", technicalNotes: null, handlingNotes: null });
    expect(outboxModel.findLatestPayload).toHaveBeenCalledWith("equipment_details", 41);
  });

  test("[TC-07] should_return_null_for_an_item_that_never_had_an_entry", async () => {
    outboxModel.findLatestPayload.mockResolvedValue(null);

    await expect(equipmentModel.findCurrentDetails(41)).resolves.toBeNull();
  });
});
