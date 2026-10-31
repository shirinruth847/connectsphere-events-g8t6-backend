// SPM-76: each venue choice may carry a requested time. Real migration
// functions in a reduced, isolated PostgreSQL fixture; no hosted writes.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8");
const functionSql = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, name);
  return match[0];
};
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const EVENT = {
  title: "SPM-76 synthetic request", purpose: "Forum", description: "Synthetic event",
  start_datetime: "2035-01-01T01:00:00Z", end_datetime: "2035-01-01T10:00:00Z",
  expected_attendance: 150, preferred_layout_type: "NO_PREFERENCE",
};
const save = async (db, { id = null, fields = EVENT, preferences = null, equipment = null, key = null } = {}) =>
  (await one(db, "SELECT public.save_event_draft(1,$1,$2::jsonb,$3::jsonb,$4::jsonb,false,$5,$6,NULL) AS result",
    [id, JSON.stringify(fields), preferences === null ? null : JSON.stringify(preferences), equipment === null ? null : JSON.stringify(equipment), key, key ? "c".repeat(64) : null])).result;
const submit = async (db, id) =>
  (await one(db, "SELECT public.submit_event_request(1,$1,'{}'::jsonb,NULL,NULL,NULL,NULL) AS result", [id])).result;
const stored = async (db, id) =>
  (await db.query("SELECT venue_id, requested_start, requested_end FROM public.event_venue_preference WHERE event_id=$1 ORDER BY preference_order", [id])).rows
    .map((row) => [row.venue_id, row.requested_start?.toISOString() ?? null, row.requested_end?.toISOString() ?? null]);
const choice = (venue_id, requested_start, requested_end) => ({ venue_id, requested_start, requested_end });

async function setup() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm177DatabaseSchema.sql"), "utf8"));
  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(idempotency.slice(idempotency.indexOf("CREATE TABLE public.idempotency_records"), idempotency.indexOf("-- The signatures change")));
  const base = read("20261007024516_atomic_event_submission.sql");
  await db.exec(functionSql(base, "_replace_event_requirements") + functionSql(base, "_event_response"));
  await db.exec("CREATE TABLE public.venue_booking (booking_id integer PRIMARY KEY)");
  await db.exec(read("20261019075314_spm244_safety_reviews.sql"));
  const lifecycle = read("20261019075510_spm173_lifecycle_transitions.sql");
  for (const name of ["_lifecycle_transitions", "_check_event_transition", "_apply_event_transition", "_notify_event_users", "_active_users_with_role"]) {
    await db.exec(functionSql(lifecycle, name));
  }
  await db.exec(functionSql(read("20261012120000_spm33_event_edit_history.sql"), "_bump_event_version"));
  await db.exec("CREATE TRIGGER event_bump_version BEFORE UPDATE ON public.event FOR EACH ROW EXECUTE FUNCTION public._bump_event_version()");
  for (const name of ["20261019171635_spm41_clarification_rounds.sql", "20261024025349_spm41_clarification_lifecycle.sql", "20261024120000_spm41_clarification_threads.sql"]) {
    await db.exec(read(name));
  }
  await db.exec("ALTER TABLE public.event ADD COLUMN submitted_at timestamptz");
  await db.exec(functionSql(read("20261019183324_spm36_submission_time_and_lead_receipt.sql"), "_record_event_submission_time"));
  await db.exec("CREATE TRIGGER event_record_submission_time BEFORE INSERT OR UPDATE ON public.event FOR EACH ROW EXECUTE FUNCTION public._record_event_submission_time()");
  await db.exec(read("20261028120000_spm38_submitted_support_needs.sql"));
  // The live table and equipment catalogue carry these; the reduced fixture does not.
  await db.exec(`ALTER TABLE public.event_venue_preference ADD UNIQUE (event_id, preference_order);
    ALTER TABLE public.equipment ADD COLUMN is_active boolean NOT NULL DEFAULT true, ADD COLUMN details_pending boolean NOT NULL DEFAULT false`);
  await db.exec(read("20261031140000_spm76_venue_preference_times.sql"));
  await db.exec(read("20261031150000_spm76_restore_choice_removal.sql"));
  await db.exec(`INSERT INTO public.venue (venue_id,name,address,max_capacity) VALUES
    (1,'SPM-76 Hall','1 Synthetic Road',300),(2,'SPM-76 Breakout','1 Synthetic Road',60),(3,'SPM-76 Studio','1 Synthetic Road',40)`);
  await db.exec(`INSERT INTO public.equipment (equipment_id,name,category) VALUES (1,'Projector','AV'),(2,'Microphone','AV')`);
  await db.exec(`INSERT INTO public."user" (user_id,email,name,role,is_active) VALUES
    (1,'spm76-owner@example.test','Owner','ORGANISER',true),
    (4,'spm76-lead@example.test','Lead','COORDINATOR_LEAD',true)`);
  return db;
}

test("[SPM-76-TC1] choices keep their own times; a whole-event time is stored as none", async () => {
  const db = await setup();
  try {
    const created = await save(db, {
      key: "spm76-create",
      preferences: [choice(1, "2035-01-01T01:00:00Z", "2035-01-01T10:00:00Z"), choice(2, "2035-01-01T05:00:00Z", "2035-01-01T07:00:00Z")],
    });
    const id = created.event.event_id;
    assert.deepEqual(await stored(db, id), [[1, null, null], [2, "2035-01-01T05:00:00.000Z", "2035-01-01T07:00:00.000Z"]]);
    assert.equal(created.venue_preferences[0], 1);
    assert.equal(created.venue_preferences[1].venue_id, 2);

    const submitted = await submit(db, id);
    assert.equal(submitted.event.status, "SUBMITTED");
    assert.deepEqual(await stored(db, id), [[1, null, null], [2, "2035-01-01T05:00:00.000Z", "2035-01-01T07:00:00.000Z"]]);
  } finally { await db.close(); }
});

test("[SPM-76-TC2] a time outside the event is refused and nothing is saved", async () => {
  const db = await setup();
  try {
    const id = (await save(db, { key: "spm76-outside", preferences: [1] })).event.event_id;
    for (const window of [["2035-01-01T00:59:00Z", "2035-01-01T03:00:00Z"], ["2035-01-01T09:00:00Z", "2035-01-01T10:01:00Z"]]) {
      await assert.rejects(save(db, { id, fields: {}, preferences: [choice(1, ...window)] }), /VENUE_PREFERENCE_OUTSIDE_EVENT/);
    }
    assert.deepEqual(await stored(db, id), [[1, null, null]]);
  } finally { await db.close(); }
});

test("[SPM-76-TC4] moving the event so a choice falls outside it is refused until the choice changes", async () => {
  const db = await setup();
  try {
    const id = (await save(db, { key: "spm76-move", preferences: [1, choice(2, "2035-01-01T08:00:00Z", "2035-01-01T10:00:00Z")] })).event.event_id;
    await assert.rejects(save(db, { id, fields: { end_datetime: "2035-01-01T08:00:00Z" } }), /VENUE_PREFERENCE_OUTSIDE_EVENT/);
    assert.equal((await one(db, "SELECT end_datetime FROM public.event WHERE event_id=$1", [id])).end_datetime.toISOString(), "2035-01-01T10:00:00.000Z");
    await save(db, { id, fields: { end_datetime: "2035-01-01T08:00:00Z" }, preferences: [1, choice(2, "2035-01-01T06:00:00Z", "2035-01-01T08:00:00Z")] });
    assert.deepEqual(await stored(db, id), [[1, null, null], [2, "2035-01-01T06:00:00.000Z", "2035-01-01T08:00:00.000Z"]]);
  } finally { await db.close(); }
});

test("[SPM-76] changing only a choice's time is recorded in the owner's history", async () => {
  const db = await setup();
  try {
    const id = (await save(db, { key: "spm76-history", preferences: [1] })).event.event_id;
    await save(db, { id, fields: {}, preferences: [choice(1, "2035-01-01T02:00:00Z", "2035-01-01T04:00:00Z")] });
    const activity = await one(db, "SELECT changes FROM public.activity_log WHERE entity_id=$1 ORDER BY log_id DESC LIMIT 1", [id]);
    assert.deepEqual(activity.changes.venuePreferences.before, [1]);
    assert.equal(activity.changes.venuePreferences.after[0].venue_id, 1);
  } finally { await db.close(); }
});

test("[SPM-76] malformed choices are refused by the function and the table", async () => {
  const db = await setup();
  try {
    const id = (await save(db, { key: "spm76-malformed" })).event.event_id;
    for (const preferences of [
      [{ venue_id: 1, requested_start: "2035-01-01T02:00:00Z" }],
      [{ venue_id: 1, booking_id: 9 }],
      [{ venue_id: "1" }],
      ["1"],
    ]) {
      await assert.rejects(save(db, { id, fields: {}, preferences }), /INVALID_VENUE_PREFERENCES/);
    }
    await assert.rejects(save(db, { id, fields: {}, preferences: [choice(1, "2035-01-01T04:00:00Z", "2035-01-01T02:00:00Z")] }), /event_venue_preference_requested_window_check/);
  } finally { await db.close(); }
});

const equipmentOf = async (db, id) =>
  (await db.query("SELECT equipment_id, quantity_requested FROM public.event_equipment_requirement WHERE event_id=$1 ORDER BY equipment_id", [id])).rows;

test("[SPM-76] reordering and narrowing keep the other choices; only a removed venue goes", async () => {
  const db = await setup();
  try {
    const id = (await save(db, { key: "spm76-reorder", preferences: [1, 2, 3] })).event.event_id;
    await save(db, { id, fields: {}, preferences: [3, choice(2, "2035-01-01T05:00:00Z", "2035-01-01T07:00:00Z")] });
    assert.deepEqual(await stored(db, id), [[3, null, null], [2, "2035-01-01T05:00:00.000Z", "2035-01-01T07:00:00.000Z"]]);
  } finally { await db.close(); }
});

test("[SPM-76] a refused save changes nothing, and duplicates are refused", async () => {
  const db = await setup();
  try {
    const id = (await save(db, { key: "spm76-refused", preferences: [1, 2], equipment: [{ equipment_id: 1, quantity: 2 }] })).event.event_id;
    await assert.rejects(save(db, { id, fields: {}, preferences: [3, 3] }), /INVALID_VENUE_PREFERENCES/);
    await assert.rejects(save(db, { id, fields: {}, preferences: [2, choice(1, "2034-01-01T00:00:00Z", "2034-01-01T02:00:00Z")] }), /VENUE_PREFERENCE_OUTSIDE_EVENT/);
    await assert.rejects(save(db, { id, fields: {}, equipment: [{ equipment_id: 2, quantity: 1 }, { equipment_id: 2, quantity: 3 }] }), /INVALID_EQUIPMENT_REQUIREMENTS/);
    assert.deepEqual(await stored(db, id), [[1, null, null], [2, null, null]]);
    assert.deepEqual(await equipmentOf(db, id), [{ equipment_id: 1, quantity_requested: 2 }]);
  } finally { await db.close(); }
});

test("[SPM-52] equipment quantities update; a kept deactivated item stays, a removed one cannot come back", async () => {
  const db = await setup();
  try {
    const id = (await save(db, { key: "spm76-equipment", equipment: [{ equipment_id: 1, quantity: 2 }, { equipment_id: 2, quantity: 1 }] })).event.event_id;
    await db.exec("UPDATE public.equipment SET is_active = false");
    await save(db, { id, fields: {}, equipment: [{ equipment_id: 1, quantity: 5 }] });
    assert.deepEqual(await equipmentOf(db, id), [{ equipment_id: 1, quantity_requested: 5 }]);
    await assert.rejects(save(db, { id, fields: {}, equipment: [{ equipment_id: 1, quantity: 5 }, { equipment_id: 2, quantity: 1 }] }), /INVALID_EQUIPMENT_REQUIREMENTS/);
    assert.deepEqual(await equipmentOf(db, id), [{ equipment_id: 1, quantity_requested: 5 }]);
  } finally { await db.close(); }
});
