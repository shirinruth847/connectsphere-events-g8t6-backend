// Real assignment and idempotency functions in an isolated engine. This suite
// does not simulate hosted independent-client concurrency, Auth or PostgREST.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, "supabase/migrations", file), "utf8");
const migration = "20261028010000_spm192_reassignment_replay.sql";
const functionSql = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, `${name} exists in its source migration`);
  return match[0];
};

async function setup(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm36DatabaseSchema.sql"), "utf8"));
  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  // Load the real table and helpers, without unrelated historical event changes.
  const table = idempotency.slice(idempotency.indexOf("CREATE TABLE public.idempotency_records"), idempotency.indexOf("-- Returns NULL"));
  await db.exec(table + functionSql(idempotency, "_claim_idempotency_key") + functionSql(idempotency, "_store_idempotent_response"));
  await db.exec(`
    CREATE UNIQUE INDEX one_active_assignment ON public.event_assignments(event_id) WHERE ended_at IS NULL;
    INSERT INTO public."user"(user_id,email,name,role) VALUES
      (1,'spm192-owner@connectsphere.test','Owner','ORGANISER'),
      (2,'spm192-lead@connectsphere.test','Lead','COORDINATOR_LEAD'),
      (3,'spm192-a@connectsphere.test','Coordinator A','COORDINATOR'),
      (4,'spm192-b@connectsphere.test','Coordinator B','COORDINATOR'),
      (5,'spm192-other@connectsphere.test','Other Lead','COORDINATOR_LEAD');
    INSERT INTO public.event(event_id,organiser_id,coordinator_id,title,status,start_datetime,end_datetime)
      VALUES (1,1,3,'Synthetic replay check','PLANNING','2030-01-01T10:00Z','2030-01-01T12:00Z');
    INSERT INTO public.event_assignments(event_id,coordinator_id,assigned_by) VALUES(1,3,2);
    -- Model a newer branch's already-allowed operation and stored replay.
    ALTER TABLE public.idempotency_records DROP CONSTRAINT idempotency_records_operation_check,
      ADD CONSTRAINT idempotency_records_operation_check CHECK (operation IN ('event.create_draft','clarification.post_message'));
    INSERT INTO public.idempotency_records VALUES(2,'clarification.post_message','existing-command',repeat('e',64),'{"messageId":7}',now());
  `);
  await db.exec(read("20261020075714_spm174_lead_assignment_conflict_guard.sql"));
  await db.exec(read("20261026093229_spm192_reassignment_names_coordinator.sql"));
  await db.exec(read(migration));
  return db;
}

const command = async (db, { target = 4, expected = 3, lead = 2, key = "spm192-command-1", hash = "a".repeat(64) } = {}) =>
  (await db.query("SELECT public.reassign_event_coordinator_idempotent(1,$1,$2,$3,$4,$5) AS result", [target, expected, lead, key, hash])).rows[0].result;
const snapshot = async (db) => {
  const result = {};
  for (const table of ["event", "event_assignments", "activity_log", "notification", "notification_recipient", "idempotency_records"]) {
    result[table] = (await db.query(`SELECT * FROM public.${table} ORDER BY 1,2`)).rows;
  }
  return result;
};

test("[SPM-192 AC10] lost response and replay after A -> B -> A create no additional assignment, history or owner notice", async (t) => {
  const db = await setup(t);
  const first = await command(db);
  assert.equal(first.replayed, false);
  let before = await snapshot(db);
  assert.equal((await command(db)).replayed, true);
  assert.deepEqual(await snapshot(db), before);
  await command(db, { target: 3, expected: 4, key: "spm192-command-2", hash: "b".repeat(64) });
  before = await snapshot(db);
  const replay = await command(db);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual(await snapshot(db), before);
  assert.equal(before.event[0].coordinator_id, 3);
  const notices = await db.query(`SELECT n.message FROM public.notification n JOIN public.notification_recipient r USING(notification_id) WHERE r.recipient_id=1 ORDER BY notification_id`);
  assert.equal(notices.rows.length, 2);
  assert.match(notices.rows[0].message, /Coordinator B, who is now your point of contact/);
  assert.doesNotMatch(notices.rows[0].message, /reason|previousCoordinatorId/);
});

test("[SPM-192 AC10] a changed payload cannot reuse a successful command key", async (t) => {
  const db = await setup(t);
  await command(db);
  const before = await snapshot(db);
  await assert.rejects(command(db, { target: 3, expected: 4, hash: "b".repeat(64) }), /IDEMPOTENCY_KEY_REUSED/);
  assert.deepEqual(await snapshot(db), before);
});

test("[SPM-192 AC10] notification failure rolls back the command claim and all business writes; retry then succeeds once", async (t) => {
  const db = await setup(t);
  await db.exec(`CREATE FUNCTION public.fail_spm192_recipient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_NOTICE_FAILURE'; END; $$;
    CREATE TRIGGER fail_spm192 BEFORE INSERT ON public.notification_recipient FOR EACH ROW EXECUTE FUNCTION public.fail_spm192_recipient();`);
  const before = await snapshot(db);
  await assert.rejects(command(db), /SYNTHETIC_NOTICE_FAILURE/);
  assert.deepEqual(await snapshot(db), before);
  await db.exec("DROP TRIGGER fail_spm192 ON public.notification_recipient");
  assert.equal((await command(db)).replayed, false);
  assert.equal((await command(db)).replayed, true);
});

test("[SPM-192 AC10] replay rechecks active Lead and supervision; browser roles cannot execute the RPC", async (t) => {
  const db = await setup(t);
  await command(db);
  await db.exec('UPDATE public."user" SET is_active=false WHERE user_id=2');
  await assert.rejects(command(db), /FORBIDDEN/);
  await db.exec('UPDATE public."user" SET is_active=true WHERE user_id=2; UPDATE public.event_assignments SET assigned_by=5 WHERE ended_at IS NULL');
  await assert.rejects(command(db), /EVENT_NOT_REASSIGNABLE/);
  await db.exec("SET ROLE authenticated");
  await assert.rejects(command(db), (error) => error.code === "42501");
  await db.exec("RESET ROLE");
});

test("[SPM-192] invalid keys and stale assignments leave no command or notice; migration preserves unrelated replay rows", async (t) => {
  const db = await setup(t);
  const before = await snapshot(db);
  await assert.rejects(command(db, { key: null }), /IDEMPOTENCY_KEY_REQUIRED/);
  await assert.rejects(command(db, { key: "bad" }), (error) => error.code === "23514");
  await assert.rejects(command(db, { expected: 4 }), /ASSIGNMENT_CHANGED/);
  assert.deepEqual(await snapshot(db), before);
  assert.deepEqual(before.idempotency_records[0].response, { messageId: 7 });
});

test("[SPM-192] replay protection preserves later assignment-ended notification types", async (t) => {
  const db = await setup(t);
  await db.exec("ALTER TYPE public.notification_type ADD VALUE 'ASSIGNMENT_ENDED'");
  const upgraded = read("20261026093229_spm192_reassignment_names_coordinator.sql").replace(
    "format('Your coordinator assignment for event request REQ-%s has ended.', lpad(p_event_id::text, 6, '0')),\n    'STATUS_CHANGE'",
    "format('Your coordinator assignment for event request REQ-%s has ended.', lpad(p_event_id::text, 6, '0')),\n    'ASSIGNMENT_ENDED'"
  );
  await db.exec(upgraded);
  await command(db);
  const { rows } = await db.query("SELECT type::text FROM public.notification WHERE title='Event assignment ended'");
  assert.deepEqual(rows, [{ type: "ASSIGNMENT_ENDED" }]);
  const before = await snapshot(db);
  await command(db);
  assert.deepEqual(await snapshot(db), before);
});
