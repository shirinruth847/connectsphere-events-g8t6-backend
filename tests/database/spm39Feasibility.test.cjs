// Isolated PostgreSQL engine tests; no hosted data, Auth or separate-client races.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8");
const helpers = read("20261007075542_event_request_review_fixes.sql");
const lifecycle = read("20261019075510_spm173_lifecycle_transitions.sql");
const versioning = read("20261012120000_spm33_event_edit_history.sql");
const extract = (sql, name) => {
  const start = sql.search(new RegExp(`CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\(`));
  assert.ok(start >= 0, `Missing real helper ${name}`);
  return sql.slice(start, sql.indexOf("\n$$;", start) + 4);
};

const setup = async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm177DatabaseSchema.sql"), "utf8"));
  const tableStart = helpers.indexOf("CREATE TABLE public.idempotency_records");
  await db.exec(helpers.slice(tableStart, helpers.indexOf("\n);", tableStart) + 3));
  for (const name of ["_claim_idempotency_key", "_store_idempotent_response"]) await db.exec(extract(helpers, name));
  await db.exec("CREATE TABLE public.safety_reviews (review_id integer, event_id integer, status text, claimed_by integer)");
  for (const name of ["_lifecycle_transitions", "_check_event_transition", "_apply_event_transition", "_notify_event_users"]) await db.exec(extract(lifecycle, name));
  await db.exec(extract(versioning, "_bump_event_version"));
  await db.exec("CREATE TRIGGER event_bump_version BEFORE UPDATE ON public.event FOR EACH ROW EXECUTE FUNCTION public._bump_event_version()");
  await db.exec(read("20261026190415_spm39_accept_feasibility.sql"));
  await db.exec(`
    INSERT INTO public."user" (user_id,name,email,role,is_active) VALUES
      (1,'SPM39 Owner','owner@spm39.test','ORGANISER',true),
      (2,'SPM39 Coordinator','coordinator@spm39.test','COORDINATOR',true),
      (3,'SPM39 Other','other@spm39.test','COORDINATOR',true),
      (4,'SPM39 Lead','lead@spm39.test','COORDINATOR_LEAD',true);
    INSERT INTO public.venue (venue_id,name,address,max_capacity) VALUES (1,'SPM39 Hall','Synthetic address',100);
    INSERT INTO public.event (event_id,organiser_id,coordinator_id,title,purpose,description,status,start_datetime,end_datetime,expected_attendance,preferred_layout_type)
      VALUES (1,1,2,'SPM39 Request','Learning','Synthetic event','UNDER_REVIEW','2030-01-01 09:00Z','2030-01-01 10:00Z',20,'NO_PREFERENCE');
    INSERT INTO public.event_venue_preference (event_id,venue_id,preference_order) VALUES (1,1,1);
  `);
  return db;
};
const accept = async (db, { actor = 2, version = 1, key = "spm39-key-0001", hash = "a".repeat(64) } = {}) =>
  (await db.query("SELECT public.accept_event_feasibility(1,$1,$2,$3,$4) AS result", [actor, version, key, hash])).rows[0].result;
const counts = async (db) => (await db.query(`SELECT
  (SELECT count(*)::int FROM public.activity_log) AS activity,
  (SELECT count(*)::int FROM public.notification) AS notifications,
  (SELECT count(*)::int FROM public.idempotency_records) AS replays`)).rows[0];

test("[SPM-39] feasibility transaction", async (t) => {
  await t.test("approves to PLANNING once with organiser-safe history and one owner notification", async () => {
    const db = await setup();
    try {
      const beforeApproval = Date.now();
      const first = await accept(db);
      assert.equal(first.event.status, "PLANNING");
      assert.equal(first.event.version, 2);
      assert.equal(first.replayed, false);
      assert.equal((await accept(db)).replayed, true);
      assert.deepEqual(await counts(db), { activity: 1, notifications: 1, replays: 1 });
      const history = (await db.query("SELECT user_id,actor_role,action,audience,changes FROM activity_log")).rows[0];
      assert.deepEqual(history, { user_id: 2, actor_role: "COORDINATOR", action: "FEASIBILITY_ACCEPTED", audience: "ORGANISER_SAFE", changes: { status: { before: "UNDER_REVIEW", after: "PLANNING" } } });
      const auditTime = (await db.query('SELECT "timestamp" FROM activity_log')).rows[0].timestamp;
      assert.ok(new Date(auditTime).getTime() >= beforeApproval, "audit timestamp records the approval time");
      assert.ok(new Date(auditTime).getTime() <= Date.now(), "audit timestamp is not in the future");
      assert.equal((await db.query("SELECT recipient_id FROM notification_recipient")).rows[0].recipient_id, 1);
      await assert.rejects(accept(db, { hash: "b".repeat(64) }), /IDEMPOTENCY_KEY_REUSED/);
      await db.exec("UPDATE event SET coordinator_id=3 WHERE event_id=1");
      await assert.rejects(accept(db), /EVENT_NOT_FOUND/);
    } finally { await db.close(); }
  });

  const invalid = [
    ["title", "UPDATE event SET title=' '"], ["purpose", "UPDATE event SET purpose=NULL"],
    ["description", "UPDATE event SET description=NULL"], ["description", "UPDATE event SET description='   '"], ["startDatetime", "UPDATE event SET start_datetime=NULL"],
    ["endDatetime", "UPDATE event SET end_datetime=NULL"],
    ["expectedAttendance", "UPDATE event SET expected_attendance=NULL"],
    ["preferredLayoutType", "UPDATE event SET preferred_layout_type=NULL"],
    ["venuePreferences", "DELETE FROM event_venue_preference"],
    ["contactEmail", "UPDATE public.\"user\" SET email='' WHERE user_id=1"],
    ["contactName", "UPDATE public.\"user\" SET name='' WHERE user_id=1"],
  ];
  for (const [field, mutation] of invalid) await t.test(`blocks missing ${field} without effects`, async () => {
    const db = await setup();
    try {
      await db.exec(mutation);
      const version = (await db.query("SELECT version FROM event WHERE event_id=1")).rows[0].version;
      await assert.rejects(accept(db, { version }), (error) => error.message === "FEASIBILITY_REQUIREMENTS_MISSING" && error.detail.split(",").includes(field));
      assert.equal((await db.query("SELECT status FROM event WHERE event_id=1")).rows[0].status, "UNDER_REVIEW");
      assert.deepEqual(await counts(db), { activity: 0, notifications: 0, replays: 0 });
    } finally { await db.close(); }
  });

  for (const status of ["DRAFT", "SUBMITTED", "AWAITING_CLARIFICATION", "PLANNING", "REJECTED", "CANCELLED"]) await t.test(`preserves ${status}`, async () => {
    const db = await setup();
    try {
      await db.query("UPDATE event SET status=$1 WHERE event_id=1", [status]);
      await assert.rejects(accept(db, { version: 2 }), /TRANSITION_NOT_ALLOWED/);
      assert.equal((await db.query("SELECT status FROM event WHERE event_id=1")).rows[0].status, status);
      assert.deepEqual(await counts(db), { activity: 0, notifications: 0, replays: 0 });
    } finally { await db.close(); }
  });

  await t.test("blocks stale, unrelated, wrong-role, inactive and unkeyed commands", async () => {
    const db = await setup();
    try {
      await assert.rejects(accept(db, { version: 9 }), /EVENT_VERSION_CONFLICT/);
      await assert.rejects(accept(db, { actor: 3 }), /EVENT_NOT_FOUND/);
      await db.exec("UPDATE event SET coordinator_id=4 WHERE event_id=1");
      await assert.rejects(accept(db, { actor: 4, version: 2 }), /FORBIDDEN/);
      await db.exec("UPDATE event SET coordinator_id=2 WHERE event_id=1; UPDATE public.\"user\" SET is_active=false WHERE user_id=2");
      await assert.rejects(accept(db, { version: 3 }), /FORBIDDEN/);
      await assert.rejects(accept(db, { key: null }), /IDEMPOTENCY_KEY_REQUIRED/);
      assert.deepEqual(await counts(db), { activity: 0, notifications: 0, replays: 0 });
    } finally { await db.close(); }
  });

  for (const table of ["activity_log", "notification_recipient"]) await t.test(`rolls back everything on ${table} failure`, async () => {
    const db = await setup();
    try {
      await db.exec(`CREATE FUNCTION spm39_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SPM39 forced failure'; END $$;
        CREATE TRIGGER spm39_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION spm39_fail()`);
      await assert.rejects(accept(db), /SPM39 forced failure/);
      assert.equal((await db.query("SELECT status FROM event WHERE event_id=1")).rows[0].status, "UNDER_REVIEW");
      assert.deepEqual(await counts(db), { activity: 0, notifications: 0, replays: 0 });
    } finally { await db.close(); }
  });

  await t.test("keeps legacy replay operations and denies browser execution", async () => {
    const db = await setup();
    try {
      await db.query("INSERT INTO idempotency_records(actor_id,operation,idempotency_key,request_hash) VALUES (2,'event.create_draft','spm39-legacy',$1)", ["a".repeat(64)]);
      for (const role of ["anon", "authenticated"]) {
        assert.equal((await db.query("SELECT has_function_privilege($1,'public.accept_event_feasibility(integer,integer,integer,text,text)','EXECUTE') AS allowed", [role])).rows[0].allowed, false);
      }
    } finally { await db.close(); }
  });
});
