// Runs real PL/pgSQL in an isolated PostgreSQL WASM engine. No hosted database
// connection, Auth users or network calls. See docs/test-plans/spm-36.md.
const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(__dirname, "../..");
const read = name => fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8");
const functionSql = (sql, name) => {
  const match = sql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, `Function ${name} must exist in its source migration`);
  return match[0];
};
let db;
const one = async (sql, values = []) => (await db.query(sql, values)).rows[0];
const draft = async () => (await one("INSERT INTO public.event (organiser_id, title, status) VALUES (1, 'Saved draft', 'DRAFT') RETURNING event_id")).event_id;
const input = () => ({ title: "Final request", purpose: "Forum", description: "Synthetic event", start_datetime: new Date(Date.now() + 7 * 86400000).toISOString(), end_datetime: new Date(Date.now() + 8 * 86400000).toISOString(), expected_attendance: 10, preferred_layout_type: "NO_PREFERENCE" });
const submit = async (id, fields = input(), owner = 1, requirements = null, key = null) => (await one("SELECT public.submit_event_request($1, $2, $3::jsonb, NULL, $4::jsonb, $5, $6) AS result", [owner, id, JSON.stringify(fields), requirements === null ? null : JSON.stringify(requirements), key, key ? "a".repeat(64) : null])).result;
const snapshot = async id => ({
  event: await one("SELECT * FROM public.event WHERE event_id=$1", [id]),
  activity: (await db.query("SELECT * FROM public.activity_log WHERE entity_name='event' AND entity_id=$1", [id])).rows,
  notifications: (await db.query("SELECT * FROM public.notification WHERE event_id=$1", [id])).rows,
});

before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm36DatabaseSchema.sql"), "utf8"));
  const base = read("20261007024516_atomic_event_submission.sql");
  await db.exec(functionSql(base, "_replace_event_requirements") + functionSql(base, "_event_response"));
  const idempotency = read("20261007075542_event_request_review_fixes.sql");
  await db.exec(idempotency.slice(idempotency.indexOf("CREATE TABLE public.idempotency_records"), idempotency.indexOf("-- The signatures change")));
  await db.exec(functionSql(read("20261012120000_spm33_event_edit_history.sql"), "_bump_event_version"));
  await db.exec("CREATE TRIGGER event_bump_version BEFORE UPDATE ON public.event FOR EACH ROW EXECUTE FUNCTION public._bump_event_version()");
  await db.exec(functionSql(read("20261012144519_spm33_owner_history_and_edit_notice.sql"), "_activity_log_defaults"));
  await db.exec("CREATE TRIGGER activity_log_defaults BEFORE INSERT ON public.activity_log FOR EACH ROW EXECUTE FUNCTION public._activity_log_defaults()");
  await db.exec(read("20261019183324_spm36_submission_time_and_lead_receipt.sql"));
  await db.exec(read("20261015121555_spm33_assignment_enters_under_review.sql"));
  await db.exec(`INSERT INTO public."user" (user_id, email, name, role, is_active) VALUES
    (1, 'spm36-1@connectsphere.test', 'Owner', 'ORGANISER', true), (2, 'spm36-2@connectsphere.test', 'One Lead', 'COORDINATOR_LEAD', true),
    (3, 'spm36-3@connectsphere.test', 'Coordinator', 'COORDINATOR', true), (4, 'spm36-4@connectsphere.test', 'Other Organiser', 'ORGANISER', true),
    (5, 'spm36-5@connectsphere.test', 'Inactive Lead', 'COORDINATOR_LEAD', false)`);
});
after(async () => { if (db) await db.close(); });

test("[BE-01/02/03/BE-N01] atomic submission keeps the ID, time and exactly the owner/one Lead audience", async () => {
  const id = await draft();
  const result = await submit(id);
  assert.equal(result.event.event_id, id);
  assert.equal(result.event.title, "Final request");
  assert.equal(result.event.status, "SUBMITTED");
  assert.equal(result.event.coordinator_id, null);
  assert.ok(Date.parse(result.event.submitted_at));
  const { rows } = await db.query("SELECT recipient_id FROM public.notification_recipient r JOIN public.notification n USING (notification_id) WHERE n.event_id=$1 ORDER BY recipient_id", [id]);
  assert.deepEqual(rows.map(r => r.recipient_id), [1, 2]);
  const log = await one("SELECT action, actor_role, audience FROM public.activity_log WHERE entity_id=$1", [id]);
  assert.deepEqual(log, { action: "EVENT_SUBMITTED", actor_role: "ORGANISER", audience: "ORGANISER_SAFE" });
});

test("[BE-05] absence of active Coordinators never blocks submission", async () => {
  await db.exec('UPDATE public."user" SET is_active=false WHERE user_id=3');
  try { assert.equal((await submit(await draft())).event.status, "SUBMITTED"); }
  finally { await db.exec('UPDATE public."user" SET is_active=true WHERE user_id=3'); }
});

test("[BE-06/BE-N02] invalid mandatory fields roll back every submission effect", async () => {
  const id = await draft(); const before = await snapshot(id);
  await assert.rejects(submit(id, { ...input(), purpose: "   " }), /INVALID_EVENT_SUBMISSION/);
  assert.deepEqual(await snapshot(id), before);
});

test("[BE-12] another Organiser cannot submit the draft", async () => {
  const id = await draft(); const before = await snapshot(id);
  await assert.rejects(submit(id, input(), 4), /EVENT_NOT_FOUND/);
  assert.deepEqual(await snapshot(id), before);
});

test("[BE-14/BE-N03] duplicate submission preserves one transition, timestamp, activity and receipt", async () => {
  const id = await draft(); await submit(id); const before = await snapshot(id);
  await assert.rejects(submit(id), /EVENT_NOT_DRAFT/);
  assert.deepEqual(await snapshot(id), before);
  assert.equal(before.activity.length, 1); assert.equal(before.notifications.length, 1);
});

test("[BE-19] requirement failure after the event write rolls the transaction back", async () => {
  const id = await draft(); const before = await snapshot(id);
  await assert.rejects(submit(id, input(), 1, [{ equipment_id: 999999, quantity: 1 }]), /foreign key/);
  assert.deepEqual(await snapshot(id), before);
});

test("[BE-N04] recipient failure rolls back event, submission time, activity and receipt", async () => {
  const id = await draft(); const before = await snapshot(id);
  await db.exec(`CREATE FUNCTION public.spm36_fail_recipient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced recipient failure'; END; $$;
    CREATE TRIGGER spm36_fail_recipient BEFORE INSERT ON public.notification_recipient FOR EACH ROW EXECUTE FUNCTION public.spm36_fail_recipient();`);
  try { await assert.rejects(submit(id), /forced recipient failure/); }
  finally { await db.exec("DROP TRIGGER spm36_fail_recipient ON public.notification_recipient; DROP FUNCTION public.spm36_fail_recipient()"); }
  assert.deepEqual(await snapshot(id), before);
});

test("[BE-17/20] Lead assignment records supervision and preserves time when an old submission retries", async () => {
  const id = await draft(); await submit(id);
  const before = (await snapshot(id)).event;
  await db.query("SELECT public.assign_event_coordinator($1, 3, 2)", [id]);
  const assigned = await snapshot(id);
  assert.equal(assigned.event.status, "UNDER_REVIEW");
  assert.equal(assigned.event.coordinator_id, 3);
  assert.equal(assigned.event.submitted_at.toISOString(), before.submitted_at.toISOString());
  assert.equal((await one("SELECT count(*)::integer AS count FROM public.activity_log WHERE entity_id=$1 AND action='COORDINATOR_ASSIGNED' AND changes->'status'->>'before'='SUBMITTED' AND changes->'status'->>'after'='UNDER_REVIEW'", [id])).count, 1);
  assert.equal((await one("SELECT assigned_by FROM public.event_assignments WHERE event_id=$1", [id])).assigned_by, 2);
  const { rows: recipients } = await db.query("SELECT n.title, r.recipient_id FROM public.notification n JOIN public.notification_recipient r USING (notification_id) WHERE n.event_id=$1 ORDER BY n.title, r.recipient_id", [id]);
  assert.deepEqual(recipients, [
    { title: "Event coordinator assigned", recipient_id: 1 },
    { title: "Event request received", recipient_id: 1 },
    { title: "Event request received", recipient_id: 2 },
    { title: "New event coordination assignment", recipient_id: 3 },
  ]);
  await assert.rejects(submit(id), /EVENT_NOT_DRAFT/);
  assert.deepEqual(await snapshot(id), assigned);
});

test("[BE-03] later updates and forged timestamps cannot overwrite first submission time", async () => {
  const id = await draft(); await submit(id); const before = (await snapshot(id)).event;
  await db.query("UPDATE public.event SET updated_at=now(), submitted_at='2000-01-01T00:00:00Z' WHERE event_id=$1", [id]);
  assert.equal((await snapshot(id)).event.submitted_at.toISOString(), before.submitted_at.toISOString());
});

test("[BE-N03] a repeated create key replays the committed event without duplicate effects", async () => {
  const fields = input(); const key = "spm36-create-retry";
  const first = await submit(null, fields, 1, null, key);
  const before = await snapshot(first.event.event_id);
  const second = await submit(null, fields, 1, null, key);
  assert.equal(second.replayed, true);
  assert.equal(second.event.event_id, first.event.event_id);
  assert.deepEqual(await snapshot(first.event.event_id), before);
});

test("[BE-04] queue order follows submission time rather than draft creation time", async () => {
  const oldDraft = await draft(); const newDraft = await draft();
  await db.query("UPDATE public.event SET created_at=CASE WHEN event_id=$1 THEN '2000-01-01'::timestamptz ELSE '2001-01-01'::timestamptz END WHERE event_id IN ($1,$2)", [oldDraft, newDraft]);
  await submit(newDraft);
  await submit(oldDraft);
  const { rows } = await db.query("SELECT event_id FROM public.event WHERE event_id IN ($1,$2) AND status='SUBMITTED' AND coordinator_id IS NULL ORDER BY submitted_at ASC NULLS LAST, created_at, event_id", [oldDraft, newDraft]);
  assert.deepEqual(rows.map(row => row.event_id), [newDraft, oldDraft]);
});

test("[BE-03] migration backfills recorded history and leaves undocumented legacy submission times unknown", async () => {
  const legacy = new PGlite();
  try {
    await legacy.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm36DatabaseSchema.sql"), "utf8"));
    await legacy.exec(`INSERT INTO public."user" (user_id,email,name,role) VALUES (1,'spm36-legacy@connectsphere.test','Legacy Owner','ORGANISER');
      INSERT INTO public.event (event_id,organiser_id,title,status,updated_at) VALUES (1,1,'Recorded','SUBMITTED','2026-10-18'),(2,1,'Unknown','SUBMITTED','2026-10-18');
      INSERT INTO public.activity_log (user_id,entity_name,entity_id,action,timestamp,actor_role,audience) VALUES
      (1,'event',1,'EVENT_SUBMITTED','2026-10-01T10:00:00Z','ORGANISER','ORGANISER_SAFE');`);
    await legacy.exec(read("20261019183324_spm36_submission_time_and_lead_receipt.sql"));
    const { rows } = await legacy.query("SELECT event_id,submitted_at FROM public.event ORDER BY event_id");
    assert.equal(rows[0].submitted_at.toISOString(), "2026-10-01T10:00:00.000Z");
    assert.equal(rows[1].submitted_at, null);
  } finally { await legacy.close(); }
});
