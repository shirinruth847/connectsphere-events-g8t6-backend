// Real migration functions on a reduced, isolated PostgreSQL fixture. These
// tests do not establish hosted RLS or separate-connection concurrency.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8");
const migration = "20261025120000_spm41_displayed_message_reads.sql";
const functionSql = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, name);
  return match[0];
};
const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];
const acknowledge = (db, id, actor = 1) => one(db, "SELECT public.mark_clarification_read(1,1,$1,$2) AS read", [actor, id]);
const post = async (db, body) => (await one(db,
  "SELECT public.post_clarification_message(1,1,1,$1,NULL,NULL) AS result", [body])).result.message;

async function setup({ migrate = true } = {}) {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm177DatabaseSchema.sql"), "utf8"));
  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(idempotency.slice(idempotency.indexOf("CREATE TABLE public.idempotency_records"), idempotency.indexOf("-- The signatures change")));
  const submission = read("20261007024516_atomic_event_submission.sql");
  await db.exec(functionSql(submission, "_replace_event_requirements") + functionSql(submission, "_event_response"));
  await db.exec("CREATE TABLE public.venue_booking (booking_id integer PRIMARY KEY)");
  await db.exec(read("20261019075314_spm244_safety_reviews.sql"));
  const lifecycle = read("20261019075510_spm173_lifecycle_transitions.sql");
  for (const name of ["_lifecycle_transitions", "_check_event_transition", "_apply_event_transition", "_notify_event_users"]) {
    await db.exec(functionSql(lifecycle, name));
  }
  for (const name of ["20261019171635_spm41_clarification_rounds.sql", "20261024025349_spm41_clarification_lifecycle.sql", "20261024120000_spm41_clarification_threads.sql"]) {
    await db.exec(read(name));
  }
  await db.exec(`
    INSERT INTO public."user" (user_id,email,name,role,is_active) VALUES
      (1,'spm41-owner@example.test','Owner','ORGANISER',true),
      (2,'spm41-coordinator@example.test','Coordinator','COORDINATOR',true),
      (3,'spm41-other@example.test','Other','ORGANISER',true);
    INSERT INTO public.event (event_id,organiser_id,coordinator_id,title,status)
      VALUES (1,1,2,'Synthetic read test','UNDER_REVIEW');
    SELECT public.request_event_clarification(1,2,1,'Question?',NULL,NULL);
  `);
  if (migrate) await db.exec(read(migration));
  return db;
}

test("[SPM-41] backfill preserves legacy reads and the cursorless overload cannot clear new replies", async () => {
  const db = await setup({ migrate: false });
  try {
    await db.exec("SELECT public.mark_clarification_read(1,1,1)");
    await db.exec(read(migration));
    const before = await one(db, "SELECT * FROM public.clarification_reads WHERE user_id=1");
    assert.equal(before.last_read_message_id, 1);
    await db.exec("SELECT public.mark_clarification_read(1,1,1)");
    assert.deepEqual(await one(db, "SELECT * FROM public.clarification_reads WHERE user_id=1"), before);
  } finally { await db.close(); }
});

test("[SPM-41] a reply between fetch and acknowledgement remains unread", async () => {
  const db = await setup();
  try {
    assert.equal((await acknowledge(db, 1)).read, true);
    const reply = await post(db, "New reply after the displayed snapshot");
    const before = await one(db, "SELECT * FROM public.clarification_reads WHERE user_id=2");
    assert.equal((await acknowledge(db, 1, 2)).read, false);
    assert.deepEqual(await one(db, "SELECT * FROM public.clarification_reads WHERE user_id=2"), before);
    assert.ok(reply.message_id > before.last_read_message_id);
    assert.equal((await acknowledge(db, reply.message_id, 2)).read, true);
    assert.equal((await one(db, "SELECT last_read_message_id FROM public.clarification_reads WHERE user_id=2")).last_read_message_id, reply.message_id);
  } finally { await db.close(); }
});

test("[SPM-41] notification throttle uses actual time after a long transaction starts", async () => {
  const db = await setup();
  try {
    const first = await post(db, "First reply");
    await db.exec("BEGIN");
    assert.equal((await acknowledge(db, first.message_id, 2)).read, true);
    const second = await post(db, "Reply with an earlier transaction-start timestamp");
    await post(db, "Another reply without another read");
    await db.exec("COMMIT");
    const reader = await one(db, "SELECT * FROM public.clarification_reads WHERE user_id=2");
    assert.equal(reader.last_read_message_id, first.message_id);
    assert.ok(second.message_id > reader.last_read_message_id);
    assert.ok(new Date(second.created_at) <= reader.last_read_at);
    assert.ok(reader.last_notified_at > reader.last_read_at);
    const notes = await one(db, "SELECT count(*)::int AS n FROM public.notification n JOIN public.notification_recipient r USING(notification_id) WHERE r.recipient_id=2");
    assert.equal(notes.n, 2); // First reply, then one notification after opening.
  } finally { await db.close(); }
});

test("[SPM-41 security] wrong actors, fabricated cursors and browser RPC execution are refused", async () => {
  const db = await setup();
  try {
    for (const cursor of [-1, null, 999]) assert.equal((await acknowledge(db, cursor)).read, false);
    assert.equal((await acknowledge(db, 1, 3)).read, false);
    await db.exec("UPDATE public.\"user\" SET is_active=false WHERE user_id=1");
    assert.equal((await acknowledge(db, 1)).read, false);
    for (const role of ["anon", "authenticated"]) {
      const result = await one(db, "SELECT has_function_privilege($1,'public.mark_clarification_read(integer,integer,integer,integer)','EXECUTE') AS allowed", [role]);
      assert.equal(result.allowed, false);
    }
  } finally { await db.close(); }
});

test("[SPM-41] a rolled-back acknowledgement does not alter the saved cursor", async () => {
  const db = await setup();
  try {
    const before = await one(db, "SELECT * FROM public.clarification_reads WHERE user_id=1");
    await db.exec("BEGIN");
    assert.equal((await acknowledge(db, 1)).read, true);
    await db.exec("ROLLBACK");
    assert.deepEqual(await one(db, "SELECT * FROM public.clarification_reads WHERE user_id=1"), before);
  } finally { await db.close(); }
});
