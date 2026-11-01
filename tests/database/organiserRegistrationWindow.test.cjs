// Real migration functions in a reduced, isolated PostgreSQL fixture.
// No hosted writes; these tests do not establish production RLS or concurrency.
const { before, after, test } = require("node:test");
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
const OPEN = "2034-12-30T20:04:00+08:00";
const CLOSE = "2034-12-31T22:04:00+08:00";
const input = () => ({
  title: "Registration window test", purpose: "Forum", description: "Synthetic event",
  start_datetime: "2035-01-01T09:00:00Z", end_datetime: "2035-01-02T10:00:00Z",
  expected_attendance: 20, preferred_layout_type: "NO_PREFERENCE", technical_support_needs: "AV setup",
  is_registration_enabled: true, registration_capacity: 1,
  registration_open_at: OPEN, registration_close_at: CLOSE,
});
let db;
const save = async ({ id = null, fields = input(), actor = 1, key = null, hash = "a".repeat(64), version = null, auto = false } = {}) =>
  (await one(db, "SELECT public.save_event_draft($1,$2,$3::jsonb,NULL,NULL,$4,$5,$6,$7) AS result",
    [actor, id, JSON.stringify(fields), auto, key, hash, version])).result;
const submit = async (id, fields = {}, key = null) =>
  (await one(db, "SELECT public.submit_event_request(1,$1,$2::jsonb,NULL,NULL,$3,$4) AS result",
    [id, JSON.stringify(fields), key, key ? "b".repeat(64) : null])).result;
const instant = (value) => new Date(value).toISOString();
const assertWindow = (event, open = OPEN, close = CLOSE) => {
  assert.equal(instant(event.registration_open_at), instant(open));
  assert.equal(instant(event.registration_close_at), instant(close));
};
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
  await db.exec(`ALTER TABLE public.event ADD CONSTRAINT event_registration_window_check
    CHECK (registration_open_at IS NULL OR registration_close_at IS NULL OR registration_close_at > registration_open_at)`);
  // Load the latest venue helper too: replacing save/submit must not undo it.
  await db.exec(`ALTER TABLE public.event_venue_preference ADD UNIQUE (event_id, preference_order);
    ALTER TABLE public.equipment ADD COLUMN is_active boolean NOT NULL DEFAULT true, ADD COLUMN details_pending boolean NOT NULL DEFAULT false`);
  await db.exec(read("20261101010000_spm76_venue_preference_times.sql"));
  await db.exec(`INSERT INTO public.event (organiser_id,title,status,is_registration_enabled)
    VALUES (1,'Legacy submitted event','SUBMITTED',true)`);
  const before = await snapshot(db);
  await db.exec(read("20261101124431_organiser_registration_window.sql"));
  assert.deepEqual(await snapshot(db), before, "migration must not rewrite existing events or their side effects");
  return db;
}

before(async () => { db = await setup(); });
after(async () => { if (db) await db.close(); });

test("draft dates persist, partial patches preserve them, manual changes enter history and autosaves do not", async () => {
  const created = await save({ key: "registration-draft" });
  const id = created.event.event_id;
  assertWindow(created.event);
  const preserved = await save({ id, fields: { title: "Changed title" } });
  assertWindow(preserved.event);
  const changedClose = "2035-01-01T08:00:00Z";
  const changed = await save({ id, fields: { registration_close_at: changedClose } });
  assertWindow(changed.event, OPEN, changedClose);
  const history = await one(db, "SELECT changes,audience FROM public.activity_log WHERE entity_id=$1 ORDER BY log_id DESC LIMIT 1", [id]);
  assert.equal(history.audience, "OWNER_ONLY");
  assert.equal(instant(history.changes.registrationCloseAt.before), instant(CLOSE));
  assert.equal(instant(history.changes.registrationCloseAt.after), instant(changedClose));
  const count = await one(db, "SELECT count(*)::int AS n FROM public.activity_log WHERE entity_id=$1", [id]);
  assertWindow((await save({ id, fields: { registration_close_at: CLOSE }, auto: true })).event);
  assert.deepEqual(await one(db, "SELECT count(*)::int AS n FROM public.activity_log WHERE entity_id=$1", [id]), count);
});

test("title-only and enabled incomplete drafts save; explicit nulls clear disabled registration", async () => {
  const incomplete = await save({ key: "registration-incomplete", fields: { title: "Draft", is_registration_enabled: true } });
  assert.equal(incomplete.event.registration_open_at, null);
  assert.equal(incomplete.event.registration_close_at, null);
  assert.equal((await save({ key: "registration-title-only", fields: { title: "Draft" } })).event.status, "DRAFT");
  const complete = await save({ key: "registration-to-disable" });
  const cleared = await save({ id: complete.event.event_id, fields: {
    is_registration_enabled: false, registration_capacity: null, registration_open_at: null, registration_close_at: null,
  } });
  assert.equal(cleared.event.registration_open_at, null);
  assert.equal(cleared.event.registration_close_at, null);
  const submitted = await submit(complete.event.event_id);
  assert.equal(submitted.event.status, "SUBMITTED");
  assert.equal(submitted.event.registration_close_at, null);
});

test("direct and saved-draft submission persist dates and preserve support needs and the submission lifecycle", async () => {
  const direct = await submit(null, input(), "registration-direct");
  assertWindow(direct.event);
  const draft = await save({ key: "registration-to-submit" });
  const saved = await submit(draft.event.event_id);
  assertWindow(saved.event);
  for (const result of [direct, saved]) {
    assert.equal(result.event.status, "SUBMITTED");
    assert.equal(result.event.coordinator_id, null);
    assert.ok(result.event.submitted_at);
    assert.equal(result.event.technical_support_needs, "AV setup");
  }
  const boundary = await submit(null, { ...input(), registration_close_at: input().start_datetime }, "registration-boundary");
  assertWindow(boundary.event, OPEN, input().start_datetime);
});

test("partial saved-draft submissions can override a date and preserve the other", async () => {
  const draft = await save({ key: "registration-partial-submit" });
  const submitted = await submit(draft.event.event_id, { registration_close_at: input().start_datetime });
  assertWindow(submitted.event, OPEN, input().start_datetime);
});

test("missing dates reject enabled submission with field details and roll back every effect", async () => {
  for (const field of ["registration_open_at", "registration_close_at"]) {
    const before = await snapshot(db);
    await assert.rejects(submit(null, { ...input(), [field]: null }, "registration-missing"), (error) => {
      assert.equal(error.message, "INVALID_EVENT_SUBMISSION");
      assert.equal(error.detail, field === "registration_open_at" ? "registrationOpenAt:REQUIRED" : "registrationCloseAt:REQUIRED");
      return true;
    });
    assert.deepEqual(await snapshot(db), before);
  }
});

test("invalid ordering and moving an event before its saved registration close are atomic", async () => {
  const draft = await save({ key: "registration-invalid" });
  const id = draft.event.event_id;
  for (const fields of [
    { registration_close_at: OPEN },
    { registration_close_at: "2035-01-02T09:00:00Z" },
    { start_datetime: "2034-12-30T23:00:00Z" },
  ]) {
    const before = await snapshot(db);
    await assert.rejects(save({ id, fields }), (error) => error.constraint === "event_registration_window_check" || error.message === "INVALID_EVENT_SUBMISSION");
    await assert.rejects(submit(id, fields), (error) => error.constraint === "event_registration_window_check" || error.message === "INVALID_EVENT_SUBMISSION");
    assert.deepEqual(await snapshot(db), before);
  }
});

test("date changes preserve owner-only writes, stale version protection and idempotent retries", async () => {
  const first = await save({ key: "registration-replay" });
  const before = await snapshot(db);
  assertWindow((await save({ key: "registration-replay" })).event);
  assert.deepEqual(await snapshot(db), before);
  const id = first.event.event_id;
  await assert.rejects(save({ id, actor: 3, fields: { registration_close_at: null } }), /EVENT_NOT_FOUND/);
  await save({ id, fields: { registration_close_at: input().start_datetime } });
  const changed = await snapshot(db);
  await assert.rejects(save({ id, version: first.event.version, fields: { registration_close_at: CLOSE } }), /EVENT_VERSION_CONFLICT/);
  assert.deepEqual(await snapshot(db), changed);
  const direct = await submit(null, input(), "registration-submit-replay");
  const committed = await snapshot(db);
  assert.equal((await submit(null, input(), "registration-submit-replay")).event.event_id, direct.event.event_id);
  assert.deepEqual(await snapshot(db), committed);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    try { await assert.rejects(save({ id }), (error) => error.code === "42501"); }
    finally { await db.exec("RESET ROLE"); }
  }
});
