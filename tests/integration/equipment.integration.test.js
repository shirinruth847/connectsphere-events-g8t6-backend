// SPM-52 live integration tests: real routes, Supabase Auth and the shared
// development database. Needs migrations 20261024045601_spm52_equipment_catalogue,
// 20261024050100_spm52_event_equipment_selectable and
// 20261025130000_spm52_outbox_retry_and_past_segments. MongoDB is a local
// in-memory replica set (Master M7), never Atlas.
//
// Equipment is synthetic (spm52-<run> ...). It references the Technical Support
// fixture profile, so this suite removes its equipment, unavailable stock and
// outbox entries through the privileged test connection (TEST_DATABASE_URL)
// before the shared fixture cleanup removes the profiles.
//
// Entries this suite leaves pending are parked (next_attempt_at = infinity) as
// soon as they exist, so another developer's sync job never applies them to
// Atlas; the suite applies them itself by entry ID.
//
// TC-17 (cancel the create form) is browser-only: a cancelled form sends no request.
const crypto = require("crypto");
const request = require("supertest");
const { Client } = require("pg");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const app = require("../../server");
const supabase = require("../../config/supabase");
const outboxModel = require("../../model/outboxModel");
const { getMongoDb, closeMongoDb } = require("../../config/mongodb");
const { applyMigrations } = require("../../mongodb/migrate");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");

jest.setTimeout(180000);

const runId = newRunId();
const prefix = `spm52-${runId}`;
const ORIGINAL_MONGODB_URI = process.env.MONGODB_URI;
const ORIGINAL_MONGODB_DB_NAME = process.env.MONGODB_DB_NAME;
const UNREACHABLE_MONGODB_URI = "mongodb://127.0.0.1:9/?directConnection=true";
const createdEquipmentIds = [];
const sessions = new Map();
let fixtures;
let replSet;

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      return session;
    }));
  }
  return sessions.get(key);
};

const call = async (key, method, path, body, headers = {}) => {
  const session = await signIn(key);
  let builder = request(app)[method](path).set("Authorization", `Bearer ${session.access_token}`);
  for (const [name, value] of Object.entries(headers)) builder = builder.set(name, value);
  return body === undefined ? builder : builder.send(body);
};

const withPrivileged = async (work) => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
};

const createItem = async (name, extra = {}) => {
  const response = await call("techSupport", "post", "/api/equipment", {
    name: `${prefix} ${name}`,
    category: "Audio",
    storageLocation: "Store Room A",
    totalQuantity: 5,
    ...extra,
  });
  if (response.body.equipment) createdEquipmentIds.push(response.body.equipment.equipmentId);
  return response;
};

// Keeps the item's pending entries away from every sync job's batch claim.
// applyEntryNow still claims them by ID.
const parkPendingEntries = (equipmentId) => withPrivileged((client) => client.query(
  "UPDATE public.outbox_entries SET next_attempt_at = 'infinity' WHERE target_collection = 'equipment_details' AND document_id = $1 AND state = 'PENDING'",
  [String(equipmentId)]
));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const futureHour = (dayOffset, hour, minute = 0) => {
  const date = new Date(Date.UTC(2031, 0, 6 + dayOffset, hour, minute));
  return date.toISOString();
};

const period = (from, to, quantity, extra = {}) => ({ quantity, reason: "DAMAGED", startsAt: from, endsAt: to, note: "Synthetic SPM-52 record", ...extra });

const entriesFor = async (equipmentId) => {
  const { data, error } = await supabase
    .from("outbox_entries")
    .select("entry_id,pg_version,state,attempts,payload")
    .eq("target_collection", "equipment_details")
    .eq("document_id", String(equipmentId))
    .order("pg_version", { ascending: true });
  if (error) throw error;
  return data;
};

const activityFor = async (equipmentId) => {
  const { data, error } = await supabase
    .from("activity_log")
    .select("action,changes,audience,actor_role")
    .eq("entity_name", "equipment")
    .eq("entity_id", equipmentId)
    .order("log_id", { ascending: true });
  if (error) throw error;
  return data;
};

const newDraft = (title, equipmentRequirements) => call(
  "organiserA",
  "post",
  "/api/events/drafts",
  { title: `${prefix} ${title}`, equipmentRequirements },
  { "Idempotency-Key": crypto.randomUUID() }
);

const recordDraft = (response) => {
  if (response.body.event) recordFixtureIds(runId, "eventIds", [response.body.event.eventId]);
};

const setMongoUnavailable = async () => {
  await closeMongoDb();
  process.env.MONGODB_URI = UNREACHABLE_MONGODB_URI;
};

const restoreMongo = async () => {
  await closeMongoDb();
  process.env.MONGODB_URI = replSet.getUri();
};

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.MONGODB_DB_NAME = `spm52_${runId}`;
  await applyMigrations(await getMongoDb());
  fixtures = await createAuthFixtures(runId, { extraAccounts: [{ key: "safetyOfficer", role: "SAFETY_OFFICER" }] });
});

afterAll(async () => {
  try {
    if (createdEquipmentIds.length) {
      await withPrivileged(async (client) => {
        await client.query("BEGIN");
        await client.query("DELETE FROM public.event_equipment_requirement WHERE equipment_id = ANY($1::integer[])", [createdEquipmentIds]);
        await client.query("DELETE FROM public.equipment_unavailability WHERE equipment_id = ANY($1::integer[])", [createdEquipmentIds]);
        await client.query(
          "DELETE FROM public.outbox_entries WHERE target_collection = 'equipment_details' AND document_id = ANY($1::text[])",
          [createdEquipmentIds.map(String)]
        );
        await client.query("DELETE FROM public.equipment WHERE equipment_id = ANY($1::integer[]) AND name LIKE $2", [createdEquipmentIds, `${prefix} %`]);
        await client.query("COMMIT");
      });
    }
    await cleanupAuthFixtures(runId);
  } finally {
    await closeMongoDb();
    await replSet.stop();
    process.env.MONGODB_URI = ORIGINAL_MONGODB_URI;
    process.env.MONGODB_DB_NAME = ORIGINAL_MONGODB_DB_NAME;
  }
});

describe("SPM-52 access", () => {
  test.each(["organiserA", "coordinatorLead", "coordinator", "venueStaff", "safetyOfficer", "attendee"])(
    "[TC-05] should_refuse_%s_on_every_catalogue_route_and_change_nothing",
    async (key) => {
      const responses = await Promise.all([
        call(key, "get", "/api/equipment"),
        call(key, "post", "/api/equipment", { name: `${prefix} forbidden ${key}`, category: "Audio", storageLocation: "A", totalQuantity: 1 }),
        call(key, "put", `/api/equipment/${fixtures.equipmentId}`, { storageLocation: "B", version: 1 }),
        call(key, "put", `/api/equipment/${fixtures.equipmentId}/status`, { active: false, version: 1 }),
      ]);

      responses.forEach((response) => expect(response.status).toBe(403));
      const { data } = await supabase.from("equipment").select("equipment_id").eq("name", `${prefix} forbidden ${key}`);
      expect(data).toEqual([]);
    }
  );
});

describe("SPM-52 catalogue", () => {
  test("[TC-01] should_create_an_item_apply_its_detail_and_write_one_activity_entry", async () => {
    const response = await createItem("Laser Projector", { category: "Visual", storageLocation: "Store Room B", totalQuantity: 4, specifications: "4K, 5000 lm" });

    expect(response.status).toBe(201);
    // The post-commit attempt applied the document, so the item is already Active.
    expect(response.body.equipment).toMatchObject({ status: "ACTIVE", detailStatus: "CURRENT", version: 1, totalQuantity: 4, storageLocation: "Store Room B" });
    const id = response.body.equipment.equipmentId;

    const db = await getMongoDb();
    expect(await db.collection("equipment_details").findOne({ _id: String(id) })).toMatchObject({ pg_version: 1, specifications: "4K, 5000 lm", category: "Visual" });
    expect((await entriesFor(id)).map((entry) => entry.state)).toEqual(["APPLIED"]);
    const activity = await activityFor(id);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ action: "EQUIPMENT_CREATED", audience: "STAFF_ONLY", actor_role: "TECH_SUPPORT" });
  });

  test("[TC-02] should_name_each_missing_field_and_create_nothing", async () => {
    const response = await call("techSupport", "post", "/api/equipment", { name: "", category: "Audio", storageLocation: "A", totalQuantity: "" });

    expect(response.status).toBe(400);
    expect(response.body.fields).toEqual({ name: "Name is required", totalQuantity: "Total quantity is required" });
  });

  test("[TC-04] should_refuse_a_name_that_differs_only_in_letter_case", async () => {
    expect((await createItem("Wireless Microphone")).status).toBe(201);

    const duplicate = await createItem("wireless microphone");

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.fields).toEqual({ name: "Equipment with this name already exists" });
  });

  test("[TC-06] should_save_location_and_quantity_raise_the_version_and_record_before_and_after", async () => {
    const id = (await createItem("Mixer Desk")).body.equipment.equipmentId;

    const response = await call("techSupport", "put", `/api/equipment/${id}`, { storageLocation: "Store Room C", totalQuantity: 6, version: 1 });

    expect(response.status).toBe(200);
    expect(response.body.equipment).toMatchObject({ storageLocation: "Store Room C", totalQuantity: 6, version: 2 });
    const reloaded = await call("techSupport", "get", `/api/equipment/${id}`);
    expect(reloaded.body.equipment).toMatchObject({ storageLocation: "Store Room C", totalQuantity: 6, version: 2 });
    const updated = (await activityFor(id)).find((entry) => entry.action === "EQUIPMENT_UPDATED");
    expect(updated.changes).toEqual({
      storageLocation: { before: "Store Room A", after: "Store Room C" },
      totalQuantity: { before: 5, after: 6 },
    });
    // Location and quantity are not in the MongoDB document: no new entry.
    expect(await entriesFor(id)).toHaveLength(1);
  });

  test("[TC-07] should_refuse_the_second_tab_with_the_current_values", async () => {
    const id = (await createItem("Stage Box")).body.equipment.equipmentId;

    const tabA = await call("techSupport", "put", `/api/equipment/${id}`, { storageLocation: "Store Room D", version: 1 });
    const tabB = await call("techSupport", "put", `/api/equipment/${id}`, { storageLocation: "Store Room E", version: 1 });

    expect(tabA.status).toBe(200);
    expect(tabB.status).toBe(409);
    expect(tabB.body).toMatchObject({ code: "EQUIPMENT_VERSION_CONFLICT", current: { storageLocation: "Store Room D", version: 2 } });
  });

  test("[AC6] should_write_a_full_snapshot_when_a_detail_field_changes", async () => {
    const id = (await createItem("Lectern Mic", { specifications: "Gooseneck" })).body.equipment.equipmentId;

    const response = await call("techSupport", "put", `/api/equipment/${id}`, { handlingNotes: "Keep the foam cover on", version: 1 });

    expect(response.status).toBe(200);
    const entries = await entriesFor(id);
    expect(entries.map((entry) => [entry.pg_version, entry.state])).toEqual([[1, "APPLIED"], [2, "APPLIED"]]);
    expect(entries[1].payload).toMatchObject({ specifications: "Gooseneck", handlingNotes: "Keep the foam cover on" });
    const db = await getMongoDb();
    expect(await db.collection("equipment_details").findOne({ _id: String(id) })).toMatchObject({ pg_version: 2, specifications: "Gooseneck" });
  });

  test("[TC-16] should_search_and_filter_and_restore_the_full_list_when_cleared", async () => {
    await createItem("MIC wireless kit");
    const stand = (await createItem("mic stand")).body.equipment;
    await createItem("Spotlight", { category: "Lighting" });
    await call("techSupport", "put", `/api/equipment/${stand.equipmentId}/status`, { active: false, version: stand.version });
    const list = async (query) => (await call("techSupport", "get", `/api/equipment?${query}`)).body.equipment.map((item) => item.name);
    const search = encodeURIComponent(`${prefix} mic`);

    expect((await list(`search=${search}`)).sort()).toEqual([`${prefix} MIC wireless kit`, `${prefix} mic stand`].sort());
    expect(await list(`search=${encodeURIComponent(prefix)}&category=lighting`)).toEqual([`${prefix} Spotlight`]);
    expect(await list(`search=${encodeURIComponent(prefix)}&status=INACTIVE`)).toEqual([`${prefix} mic stand`]);
    expect((await list(`search=${encodeURIComponent(prefix)}`)).length).toBe(createdEquipmentIds.length);
  });
});

describe("SPM-52 unavailable stock", () => {
  test("[TC-09] should_not_add_periods_that_do_not_overlap", async () => {
    const id = (await createItem("Radio Mic Pack")).body.equipment.equipmentId;
    const record = (body) => call("techSupport", "post", `/api/equipment/${id}/unavailability`, body);

    expect((await record(period(futureHour(0, 9), futureHour(0, 10), 3))).status).toBe(201);
    expect((await record(period(futureHour(0, 10), futureHour(0, 11), 3))).status).toBe(201);
    const overlapping = await record(period(futureHour(0, 9, 30), futureHour(0, 10, 30), 3));

    expect(overlapping.status).toBe(409);
    expect(overlapping.body).toMatchObject({ code: "EQUIPMENT_STOCK_EXCEEDED", availableQuantity: 2 });
  });

  test("[TC-10] should_refuse_more_than_the_stock_and_an_end_before_the_start", async () => {
    const id = (await createItem("DI Box")).body.equipment.equipmentId;

    const tooMany = await call("techSupport", "post", `/api/equipment/${id}/unavailability`, period(futureHour(1, 9), futureHour(1, 10), 6));
    const backwards = await call("techSupport", "post", `/api/equipment/${id}/unavailability`, period(futureHour(1, 10), futureHour(1, 9), 1));

    expect(tooMany.status).toBe(409);
    expect(tooMany.body.fields.quantity).toContain("Only 5 units are left");
    expect(backwards.status).toBe(400);
    expect(backwards.body.fields).toEqual({ endsAt: "End must be after the start" });
  });

  test("[TC-08] should_refuse_a_total_below_the_committed_quantity_and_name_the_period", async () => {
    const id = (await createItem("Subwoofer")).body.equipment.equipmentId;
    await call("techSupport", "post", `/api/equipment/${id}/unavailability`, period(futureHour(7, 9), futureHour(7, 17), 3, { reason: "MAINTENANCE" }));

    const response = await call("techSupport", "put", `/api/equipment/${id}`, { totalQuantity: 2, version: 1 });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "EQUIPMENT_QUANTITY_COMMITTED", committedQuantity: 3 });
    expect(Date.parse(response.body.periodStart)).toBe(Date.parse(futureHour(7, 9)));
    expect(Date.parse(response.body.periodEnd)).toBe(Date.parse(futureHour(7, 17)));
    expect((await call("techSupport", "get", `/api/equipment/${id}`)).body.equipment.totalQuantity).toBe(5);
  });

  test("[TC-18] should_accept_only_one_of_two_simultaneous_records_that_together_exceed_stock", async () => {
    const id = (await createItem("Wedge Monitor")).body.equipment.equipmentId;
    const body = period(futureHour(2, 9), futureHour(2, 10), 3);

    const results = await Promise.all([
      call("techSupport", "post", `/api/equipment/${id}/unavailability`, body),
      call("techSupport", "post", `/api/equipment/${id}/unavailability`, body),
    ]);

    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const { data } = await supabase.from("equipment_unavailability").select("quantity").eq("equipment_id", id).eq("status", "ACTIVE");
    expect(data.reduce((sum, row) => sum + row.quantity, 0)).toBe(3);
  });

  test("[AC8] should_edit_then_end_a_record_early_and_keep_it_as_history", async () => {
    const id = (await createItem("Truss Clamp")).body.equipment.equipmentId;
    const created = (await call("techSupport", "post", `/api/equipment/${id}/unavailability`, period(futureHour(3, 9), futureHour(3, 12), 2))).body.unavailability;

    const edited = await call("techSupport", "put", `/api/equipment/${id}/unavailability/${created.unavailabilityId}`, { quantity: 1, version: 1 });
    const ended = await call("techSupport", "post", `/api/equipment/${id}/unavailability/${created.unavailabilityId}/end`, { version: 2 });
    const again = await call("techSupport", "post", `/api/equipment/${id}/unavailability/${created.unavailabilityId}/end`, { version: 3 });

    expect(edited.body.unavailability).toMatchObject({ quantity: 1, version: 2 });
    expect(ended.body.unavailability.status).toBe("CANCELLED");
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("UNAVAILABILITY_ENDED");
    expect((await activityFor(id)).map((entry) => entry.action)).toEqual([
      "EQUIPMENT_CREATED",
      "EQUIPMENT_UNAVAILABILITY_RECORDED",
      "EQUIPMENT_UNAVAILABILITY_UPDATED",
      "EQUIPMENT_UNAVAILABILITY_ENDED",
    ]);
  });

  test("[AC8] should_let_a_started_record_be_edited_after_the_total_was_lowered_below_past_use", async () => {
    const id = (await createItem("Cable Ramp")).body.equipment.equipmentId;
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const inTwoHours = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const started = (await call("techSupport", "post", `/api/equipment/${id}/unavailability`, period(hourAgo, inTwoHours, 3))).body.unavailability;
    const other = (await call("techSupport", "post", `/api/equipment/${id}/unavailability`, period(hourAgo, inTwoHours, 2))).body.unavailability;
    // The second record ends now, so its 2 units count only in the past.
    expect((await call("techSupport", "post", `/api/equipment/${id}/unavailability/${other.unavailabilityId}/end`, { version: 1 })).status).toBe(200);
    expect((await call("techSupport", "put", `/api/equipment/${id}`, { totalQuantity: 3, version: 1 })).status).toBe(200);

    const edited = await call("techSupport", "put", `/api/equipment/${id}/unavailability/${started.unavailabilityId}`, { note: "Still at the repairer", version: 1 });

    expect(edited.status).toBe(200);
    expect(edited.body.unavailability).toMatchObject({ note: "Still at the repairer", quantity: 3 });
  });
});

describe("SPM-52 selection by event requests", () => {
  test("[TC-11] should_warn_with_the_upcoming_event_keep_its_request_and_refuse_new_ones", async () => {
    const item = (await createItem("Confidence Monitor")).body.equipment;
    const draft = await newDraft("keeps monitor", [{ equipmentId: item.equipmentId, quantity: 1 }]);
    recordDraft(draft);
    expect(draft.status).toBe(201);
    const planningEventId = fixtures.events.reassignable;
    const { error } = await supabase.from("event_equipment_requirement").insert({ event_id: planningEventId, equipment_id: item.equipmentId, quantity_requested: 1 });
    expect(error).toBeNull();

    const warned = await call("techSupport", "put", `/api/equipment/${item.equipmentId}/status`, { active: false, version: item.version });
    expect(warned.status).toBe(409);
    expect(warned.body.upcomingEvents.map((event) => event.eventId)).toEqual([planningEventId]);
    // The organiser's private draft is never named to Technical Support.
    expect(warned.body.upcomingEvents.map((event) => event.eventId)).not.toContain(draft.body.event.eventId);

    const confirmed = await call("techSupport", "put", `/api/equipment/${item.equipmentId}/status`, { active: false, version: item.version, confirmUpcomingRequests: true });
    expect(confirmed.body.equipment).toMatchObject({ status: "INACTIVE", isActive: false });

    const kept = await call("organiserA", "put", `/api/events/${draft.body.event.eventId}/draft`, {
      title: `${prefix} keeps monitor (edited)`,
      equipmentRequirements: [{ equipmentId: item.equipmentId, quantity: 2 }],
    });
    expect(kept.status).toBe(200);
    const refused = await newDraft("new monitor request", [{ equipmentId: item.equipmentId, quantity: 1 }]);
    recordDraft(refused);
    expect(refused.status).toBe(400);
    expect(refused.body.fields).toHaveProperty("equipmentRequirements");
  });

  test("[TC-12] should_keep_the_change_flag_it_and_stay_selectable_until_the_job_applies_it", async () => {
    const item = (await createItem("Shotgun Mic", { specifications: "Super-cardioid" })).body.equipment;

    await setMongoUnavailable();
    let edited;
    try {
      edited = await call("techSupport", "put", `/api/equipment/${item.equipmentId}`, { specifications: "Super-cardioid, 48 V", version: 1 });
    } finally {
      await restoreMongo();
    }
    await parkPendingEntries(item.equipmentId);

    expect(edited.status).toBe(200);
    expect(edited.body.equipment).toMatchObject({ status: "ACTIVE", detailStatus: "OUT_OF_DATE", detailNotice: "Details may be out of date", version: 2 });
    const usable = await newDraft("shotgun while out of date", [{ equipmentId: item.equipmentId, quantity: 1 }]);
    recordDraft(usable);
    expect(usable.status).toBe(201);

    // An outage is retried, never counted towards FAILED (Master 7.3).
    const pending = (await entriesFor(item.equipmentId)).find((entry) => entry.pg_version === 2);
    expect(pending).toMatchObject({ state: "PENDING", attempts: 0 });
    await expect(outboxModel.applyEntryNow(pending.entry_id)).resolves.toBe("APPLIED");

    const reloaded = await call("techSupport", "get", `/api/equipment/${item.equipmentId}`);
    expect(reloaded.body.equipment).toMatchObject({ detailStatus: "CURRENT", detailNotice: null });
    expect(reloaded.body.details).toMatchObject({ specifications: "Super-cardioid, 48 V", pgVersion: 2 });
  });

  test("[TC-20] should_refuse_a_details_pending_item_until_its_document_is_applied", async () => {
    await setMongoUnavailable();
    let created;
    try {
      created = await createItem("Pending Lapel Mic");
    } finally {
      await restoreMongo();
    }
    const item = created.body.equipment;
    await parkPendingEntries(item.equipmentId);
    expect(item).toMatchObject({ status: "DETAILS_PENDING", statusLabel: "Details pending" });
    // [TC-16] the status filter follows the item from Details pending to Active.
    const listedAs = async (status) => (await call("techSupport", "get", `/api/equipment?search=${encodeURIComponent(`${prefix} Pending Lapel`)}&status=${status}`))
      .body.equipment.map((listed) => listed.equipmentId);
    expect(await listedAs("DETAILS_PENDING")).toEqual([item.equipmentId]);
    expect(await listedAs("ACTIVE")).toEqual([]);

    const refused = await newDraft("pending lapel", [{ equipmentId: item.equipmentId, quantity: 1 }]);
    recordDraft(refused);
    expect(refused.status).toBe(400);

    const [entry] = await entriesFor(item.equipmentId);
    await expect(outboxModel.applyEntryNow(entry.entry_id)).resolves.toBe("APPLIED");
    expect(await listedAs("ACTIVE")).toEqual([item.equipmentId]);
    expect(await listedAs("DETAILS_PENDING")).toEqual([]);
    const accepted = await newDraft("applied lapel", [{ equipmentId: item.equipmentId, quantity: 1 }]);
    recordDraft(accepted);
    expect(accepted.status).toBe(201);
  });

  test("[TC-20] should_refuse_inactive_and_pending_items_in_the_database_function_too", async () => {
    const inactive = (await createItem("Inactive Boom Arm")).body.equipment;
    await call("techSupport", "put", `/api/equipment/${inactive.equipmentId}/status`, { active: false, version: inactive.version });
    await setMongoUnavailable();
    let pending;
    try {
      pending = (await createItem("Pending Boom Arm")).body.equipment;
    } finally {
      await restoreMongo();
    }
    await parkPendingEntries(pending.equipmentId);
    const eventId = fixtures.events.ownDraft;

    await withPrivileged(async (client) => {
      await client.query("BEGIN");
      try {
        for (const item of [inactive, pending]) {
          await client.query("SAVEPOINT attempt");
          await expect(client.query("SELECT public._replace_event_requirements($1, NULL, $2)", [
            eventId,
            JSON.stringify([{ equipment_id: item.equipmentId, quantity: 1 }]),
          ])).rejects.toMatchObject({ message: "INVALID_EQUIPMENT_REQUIREMENTS" });
          await client.query("ROLLBACK TO SAVEPOINT attempt");
        }
      } finally {
        await client.query("ROLLBACK");
      }
    });
    const [entry] = await entriesFor(pending.equipmentId);
    await expect(outboxModel.applyEntryNow(entry.entry_id)).resolves.toBe("APPLIED");
  });
});

describe("SPM-52 outbox and rollback", () => {
  test("[TC-19] should_mark_an_entry_failed_after_the_attempt_limit_and_keep_it", async () => {
    const item = (await createItem("Failing Mic")).body.equipment;
    await setMongoUnavailable();
    try {
      await call("techSupport", "put", `/api/equipment/${item.equipmentId}`, { specifications: "Will not sync", version: 1 });
    } finally {
      await restoreMongo();
    }
    await parkPendingEntries(item.equipmentId);
    const entry = (await entriesFor(item.equipmentId)).find((row) => row.pg_version === 2);
    // An entry that keeps failing: its document breaks the validator's 2000-character limit.
    await withPrivileged((client) => client.query(
      "UPDATE public.outbox_entries SET payload = jsonb_set(payload, '{specifications}', to_jsonb(repeat('x', 2001))) WHERE entry_id = $1",
      [entry.entry_id]
    ));

    await expect(outboxModel.applyEntryNow(entry.entry_id, 2)).resolves.toBe("PENDING");
    await expect(outboxModel.applyEntryNow(entry.entry_id, 2)).resolves.toBe("FAILED");

    expect((await entriesFor(item.equipmentId)).find((row) => row.pg_version === 2)).toMatchObject({ state: "FAILED", attempts: 2 });
    const reloaded = await call("techSupport", "get", `/api/equipment/${item.equipmentId}`);
    expect(reloaded.body.equipment).toMatchObject({ detailStatus: "FAILED", detailNotice: "Details may be out of date" });
  });

  test("[7.3] should_count_an_abandoned_lease_and_give_up_at_the_limit", async () => {
    const item = (await createItem("Abandoned Mic")).body.equipment;
    await setMongoUnavailable();
    try {
      await call("techSupport", "put", `/api/equipment/${item.equipmentId}`, { specifications: "Worker died", version: 1 });
    } finally {
      await restoreMongo();
    }
    await parkPendingEntries(item.equipmentId);
    const entry = (await entriesFor(item.equipmentId)).find((row) => row.pg_version === 2);

    // A worker claims the entry and stops before recording anything, twice.
    const { data: first } = await supabase.rpc("claim_outbox_entry", { p_entry_id: entry.entry_id, p_lease_seconds: 1 });
    expect(first).toHaveLength(1);
    await sleep(1500);
    const { data: second } = await supabase.rpc("claim_outbox_entry", { p_entry_id: entry.entry_id, p_lease_seconds: 1, p_max_attempts: 8 });
    expect(second[0]).toMatchObject({ entry_id: entry.entry_id, attempts: 1 });
    await sleep(1500);
    const { data: third } = await supabase.rpc("claim_outbox_entry", { p_entry_id: entry.entry_id, p_lease_seconds: 1, p_max_attempts: 2 });

    expect(third).toEqual([]);
    expect((await entriesFor(item.equipmentId)).find((row) => row.pg_version === 2)).toMatchObject({ state: "FAILED", attempts: 2 });
  });

  test("[TC-14] should_leave_no_change_and_no_outbox_entry_when_the_activity_insert_fails", async () => {
    const item = (await createItem("Rollback Mic")).body.equipment;
    const actorId = fixtures.accounts.techSupport.userId;

    // A trigger that fails this item's activity insert exists only inside this
    // transaction, which is rolled back.
    await withPrivileged(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query(`
          CREATE FUNCTION pg_temp.spm52_fail_activity() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.entity_name = 'equipment' AND NEW.entity_id = ${Number(item.equipmentId)} THEN
              RAISE EXCEPTION 'SPM52_FORCED_ACTIVITY_FAILURE';
            END IF;
            RETURN NEW;
          END;
          $$`);
        await client.query("CREATE TRIGGER spm52_fail_activity BEFORE INSERT ON public.activity_log FOR EACH ROW EXECUTE FUNCTION pg_temp.spm52_fail_activity()");
        await client.query("SAVEPOINT edit");
        await expect(client.query("SELECT public.update_equipment($1, $2, 1, $3)", [actorId, item.equipmentId, { name: `${prefix} Rollback Mic renamed`, specifications: "x" }]))
          .rejects.toMatchObject({ message: "SPM52_FORCED_ACTIVITY_FAILURE" });
        await client.query("ROLLBACK TO SAVEPOINT edit");
        const { rows } = await client.query(
          "SELECT e.name, e.version, (SELECT count(*)::int FROM public.outbox_entries o WHERE o.document_id = e.equipment_id::text) AS entries FROM public.equipment e WHERE e.equipment_id = $1",
          [item.equipmentId]
        );
        expect(rows[0]).toEqual({ name: `${prefix} Rollback Mic`, version: 1, entries: 1 });
      } finally {
        await client.query("ROLLBACK");
      }
    });

    const db = await getMongoDb();
    expect(await db.collection("equipment_details").findOne({ _id: String(item.equipmentId) })).toMatchObject({ pg_version: 1, name: `${prefix} Rollback Mic` });
  });
});
