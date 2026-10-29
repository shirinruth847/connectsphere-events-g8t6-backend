// Real migration functions in a reduced, isolated PostgreSQL fixture.
// No hosted writes; these tests do not establish production RLS or concurrency.
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
const input = (technical_support_needs = "AV setup") => ({
  title: "SPM-38 synthetic request", purpose: "Forum", description: "Synthetic event",
  start_datetime: "2035-01-01T09:00:00Z", end_datetime: "2035-01-01T10:00:00Z",
  expected_attendance: 20, preferred_layout_type: "NO_PREFERENCE", technical_support_needs,
});
const save = async (db, { id = null, fields = input(), actor = 1, key = null, hash = "a".repeat(64), version = null } = {}) =>
  (await one(db, "SELECT public.save_event_draft($1,$2,$3::jsonb,NULL,NULL,false,$4,$5,$6) AS result",
    [actor, id, JSON.stringify(fields), key, hash, version])).result;
const submit = async (db, id, fields = {}, key = null) =>
  (await one(db, "SELECT public.submit_event_request(1,$1,$2::jsonb,NULL,NULL,$3,$4) AS result",
    [id, JSON.stringify(fields), key, key ? "b".repeat(64) : null])).result;
const snapshot = (db) => one(db, `SELECT jsonb_build_object(
  'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM public.event e),
  'activity',(SELECT jsonb_agg(to_jsonb(a) ORDER BY log_id) FROM public.activity_log a),
  'notifications',(SELECT jsonb_agg(to_jsonb(n) ORDER BY notification_id) FROM public.notification n),
  'recipients',(SELECT jsonb_agg(to_jsonb(r) ORDER BY notification_id,recipient_id) FROM public.notification_recipient r),
  'idempotency',(SELECT jsonb_agg(to_jsonb(i)) FROM public.idempotency_records i)) AS state`);

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
  await db.exec(`INSERT INTO public."user" (user_id,email,name,role,is_active) VALUES
    (1,'spm38-owner@example.test','Owner','ORGANISER',true),
    (2,'spm38-coordinator@example.test','Coordinator','COORDINATOR',true),
    (3,'spm38-other@example.test','Other','ORGANISER',true),
    (4,'spm38-lead@example.test','Lead','COORDINATOR_LEAD',true)`);
  return db;
}

test("[SPM-38] draft save, omitted-field preservation, clear and history are atomic", async () => {
  const db = await setup();
  try {
    const created = await save(db, { key: "spm38-draft", fields: input("  AV setup  ") });
    const id = created.event.event_id;
    assert.equal(created.event.technical_support_needs, "AV setup");
    const preserved = await save(db, { id, fields: { title: "Changed title" } });
    assert.equal(preserved.event.technical_support_needs, "AV setup");
    const cleared = await save(db, { id, fields: { technical_support_needs: null } });
    assert.equal(cleared.event.technical_support_needs, null);
    const activity = await one(db, "SELECT changes,audience FROM public.activity_log WHERE entity_id=$1 ORDER BY log_id DESC LIMIT 1", [id]);
    assert.deepEqual(activity.changes.technicalSupportNeeds, { before: "AV setup", after: null });
    assert.equal(activity.audience, "OWNER_ONLY");
  } finally { await db.close(); }
});

test("[SPM-38] existing-draft and direct submission preserve support needs and the submission lifecycle", async () => {
  const db = await setup();
  try {
    const draft = await save(db, { key: "spm38-submission" });
    const submitted = await submit(db, draft.event.event_id);
    assert.equal(submitted.event.technical_support_needs, "AV setup");
    assert.equal(submitted.event.status, "SUBMITTED");
    assert.equal(submitted.event.coordinator_id, null);
    assert.ok(submitted.event.submitted_at);
    const direct = await submit(db, null, input("Presentation assistance"), "spm38-direct");
    assert.equal(direct.event.technical_support_needs, "Presentation assistance");
    const empty = await submit(db, null, input(null), "spm38-none");
    assert.equal(empty.event.technical_support_needs, null);
  } finally { await db.close(); }
});

test("[SPM-38] retries replay support needs without extra effects and stale saves fail", async () => {
  const db = await setup();
  try {
    const first = await save(db, { key: "spm38-replay" });
    const before = await snapshot(db);
    assert.equal((await save(db, { key: "spm38-replay" })).event.technical_support_needs, first.event.technical_support_needs);
    assert.deepEqual(await snapshot(db), before);
    await save(db, { id: first.event.event_id, fields: { technical_support_needs: "New support needs" } });
    const updated = await snapshot(db);
    await assert.rejects(save(db, { id: first.event.event_id, version: first.event.version, fields: { technical_support_needs: "Stale" } }), /EVENT_VERSION_CONFLICT/);
    assert.deepEqual(await snapshot(db), updated);
    const direct = await submit(db, null, input(), "spm38-submit-replay");
    const committed = await snapshot(db);
    assert.equal((await submit(db, null, input(), "spm38-submit-replay")).event.event_id, direct.event.event_id);
    assert.deepEqual(await snapshot(db), committed);
  } finally { await db.close(); }
});

test("[SPM-38] recipient failure rolls back support needs, history, notifications and idempotency", async () => {
  const db = await setup();
  try {
    await db.exec(`CREATE FUNCTION public.spm38_fail_recipient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced recipient failure'; END; $$;
      CREATE TRIGGER spm38_fail_recipient BEFORE INSERT ON public.notification_recipient FOR EACH ROW EXECUTE FUNCTION public.spm38_fail_recipient()`);
    const before = await snapshot(db);
    await assert.rejects(submit(db, null, input(), "spm38-rollback"), /forced recipient failure/);
    assert.deepEqual(await snapshot(db), before);
  } finally { await db.close(); }
});

test("[SPM-38] database enforces text/length limits, ownership and browser RPC grants", async () => {
  const db = await setup();
  try {
    const draft = await save(db, { key: "spm38-security", fields: input("a".repeat(2000)) });
    const id = draft.event.event_id;
    for (const value of [42, {}, [], "a".repeat(2001)]) {
      const before = await snapshot(db);
      await assert.rejects(save(db, { id, fields: { technical_support_needs: value } }), /INVALID_EVENT_SUBMISSION/);
      await assert.rejects(submit(db, null, input(value), "spm38-invalid"), /INVALID_EVENT_SUBMISSION/);
      assert.deepEqual(await snapshot(db), before);
    }
    await assert.rejects(save(db, { id, actor: 3, fields: { technical_support_needs: "Other owner" } }), /EVENT_NOT_FOUND/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(save(db, { id }), (error) => error.code === "42501");
      await db.exec("RESET ROLE");
    }
  } finally { await db.close(); }
});

test("[SPM-38] support needs can be amended by the owner during clarification", async () => {
  const db = await setup();
  try {
    const draft = await save(db, { key: "spm38-amend" });
    const id = draft.event.event_id;
    await submit(db, id);
    await db.query("UPDATE public.event SET coordinator_id=2,status='UNDER_REVIEW' WHERE event_id=$1", [id]);
    const current = await one(db, "SELECT version FROM public.event WHERE event_id=$1", [id]);
    await db.query("SELECT public.request_event_clarification($1,2,$2,'Which support do you need?',NULL,NULL)", [id, current.version]);
    const returned = await one(db, "SELECT version FROM public.event WHERE event_id=$1", [id]);
    await db.query("SELECT public.save_clarification_amendments($1,1,$2,$3::jsonb,NULL,NULL,NULL,NULL)", [id, returned.version, JSON.stringify({ technical_support_needs: "On-site presentation assistance" })]);
    const amended = await one(db, "SELECT technical_support_needs,status FROM public.event WHERE event_id=$1", [id]);
    assert.deepEqual(amended, { technical_support_needs: "On-site presentation assistance", status: "AWAITING_CLARIFICATION" });
  } finally { await db.close(); }
});
