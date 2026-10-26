// SPM-52 equipment_details on a local in-memory replica set (Master M7), never Atlas.
const { MongoMemoryReplSet } = require("mongodb-memory-server");

jest.setTimeout(120000);

let replSet;
let db;
let applyEquipmentDetail;
let getEquipmentDetail;
let pingEquipmentDetails;
let closeMongoDb;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = "spm52_unit";
  ({ applyEquipmentDetail, getEquipmentDetail, pingEquipmentDetails } = require("../../model/equipmentDetailModel"));
  const { applyMigrations } = require("../../mongodb/migrate");
  let getMongoDb;
  ({ getMongoDb, closeMongoDb } = require("../../config/mongodb"));
  db = await getMongoDb();
  await applyMigrations(db);
});

afterAll(async () => {
  await closeMongoDb();
  await replSet.stop();
});

const snapshot = (version, extra = {}) => ({
  equipmentId: 41,
  pgVersion: version,
  payload: { name: "Laser Projector", category: "Visual", specifications: `v${version}`, technicalNotes: null, handlingNotes: null, ...extra },
});

describe("SPM-52 equipment_details", () => {
  test("[TC-13] should_keep_the_newest_version_when_entries_arrive_late_or_twice", async () => {
    await expect(applyEquipmentDetail(snapshot(4))).resolves.toBe(true);
    await expect(applyEquipmentDetail(snapshot(3))).resolves.toBe(false);
    await expect(applyEquipmentDetail(snapshot(4))).resolves.toBe(false);

    const document = await getEquipmentDetail(41);
    expect(document).toMatchObject({ _id: "41", pg_version: 4, specifications: "v4" });
  });

  test("[AC10] should_replace_every_field_from_the_snapshot_when_a_newer_entry_applies", async () => {
    await applyEquipmentDetail(snapshot(5, { specifications: null, handlingNotes: "Two people" }));

    expect(await getEquipmentDetail(41)).toMatchObject({ pg_version: 5, specifications: null, handlingNotes: "Two people" });
  });

  test("[7.3] should_answer_the_ping_the_sync_job_checks_before_claiming", async () => {
    await expect(pingEquipmentDetails()).resolves.toBeUndefined();
  });

  test("[TC-15] should_reject_a_document_holding_total_quantity", async () => {
    await expect(db.collection("equipment_details").insertOne({ _id: "900", pg_version: 1, name: "Mixer", category: "Audio", total_quantity: 5 }))
      .rejects.toMatchObject({ code: 121 });
  });

  test("[6.4] should_reject_oversized_or_unnamed_documents", async () => {
    await expect(db.collection("equipment_details").insertOne({ _id: "901", pg_version: 1, name: "Mixer", category: "Audio", specifications: "x".repeat(2001) }))
      .rejects.toMatchObject({ code: 121 });
    await expect(db.collection("equipment_details").insertOne({ _id: "902", pg_version: 1, category: "Audio" }))
      .rejects.toMatchObject({ code: 121 });
  });
});
