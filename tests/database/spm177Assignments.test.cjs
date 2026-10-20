// In-memory PostgreSQL with a reduced schema. These tests never connect to
// hosted Supabase and do not establish separate-client concurrency or RLS.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const root = path.resolve(__dirname, '../..');
const migration = name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');

async function setup() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(root, 'tests/fixtures/spm177DatabaseSchema.sql'), 'utf8'));
  await db.exec(migration('20261007150000_assign_event_coordinator.sql'));
  await db.exec(migration('20261019100000_spm177_coordinator_assignment.sql'));
  await db.exec(migration('20261020075714_spm174_lead_assignment_conflict_guard.sql'));
  await db.exec(migration('20261020090000_spm177_lead_only_assignment.sql'));
  await db.exec(`
    CREATE UNIQUE INDEX one_active_assignment ON public.event_assignments(event_id) WHERE ended_at IS NULL;
    INSERT INTO public."user"(user_id,email,name,role,is_active) VALUES
      (1,'spm177-owner@example.test','Owner','ORGANISER',true),
      (2,'spm177-lead@example.test','Lead','COORDINATOR_LEAD',true),
      (3,'spm177-coordinator@example.test','Coordinator','COORDINATOR',true),
      (4,'spm177-inactive@example.test','Inactive','COORDINATOR',false),
      (5,'spm177-inactive-lead@example.test','Inactive Lead','COORDINATOR_LEAD',false);
    INSERT INTO public.event(event_id,organiser_id,title,status,start_datetime,end_datetime) VALUES
      (1,1,'spm177 first','SUBMITTED','2030-01-01T09:00Z','2030-01-01T10:00Z'),
      (2,1,'spm177 adjacent','SUBMITTED','2030-01-01T10:00Z','2030-01-01T11:00Z'),
      (3,1,'spm177 overlapping','SUBMITTED','2030-01-01T09:30Z','2030-01-01T10:30Z'),
      (4,1,'spm177 draft','DRAFT','2030-01-02T09:00Z','2030-01-02T10:00Z');
  `);
  return db;
}
const assign = (db, event = 1, coordinator = 3, lead = 2) => db.query('SELECT public.assign_event_coordinator($1,$2,$3) AS result', [event, coordinator, lead]);
const snapshot = async db => (await db.query(`SELECT jsonb_build_object(
  'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM public.event e),
  'assignments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY assignment_id) FROM public.event_assignments a),
  'activity',(SELECT jsonb_agg(to_jsonb(a) ORDER BY log_id) FROM public.activity_log a),
  'notifications',(SELECT jsonb_agg(to_jsonb(n) ORDER BY notification_id) FROM public.notification n),
  'recipients',(SELECT jsonb_agg(to_jsonb(n) ORDER BY notification_id,recipient_id) FROM public.notification_recipient n)) AS state`)).rows[0].state;

test('[SPM-177 AC1/AC5] Lead assignment commits state, supervision, activity and both recipients', async () => {
  const db = await setup();
  try {
    const result = (await assign(db)).rows[0].result;
    assert.equal(result.event.status, 'UNDER_REVIEW');
    assert.equal(result.event.coordinator_id, 3);
    assert.equal(result.event.coordinator.name, 'Coordinator');
    const state = await snapshot(db);
    assert.equal(state.assignments.length, 1);
    assert.equal(state.assignments[0].assigned_by, 2);
    assert.equal(state.activity[0].actor_role, 'COORDINATOR_LEAD');
    assert.equal(state.activity[0].audience, 'STAFF_ONLY');
    assert.deepEqual(state.recipients.map(row => row.recipient_id).sort(), [1, 3]);
    assert.equal(state.notifications.length, 2);
    const assignments = (await db.query('SELECT public.list_lead_event_assignments(2) AS result')).rows[0].result;
    assert.equal(assignments[0].supervisingLeadId, 2);
    assert.equal(assignments[0].coordinatorName, 'Coordinator');
    await assert.rejects(db.query("UPDATE public.event SET coordinator_id=3,status='UNDER_REVIEW' WHERE event_id=3"), error => error.message === 'COORDINATOR_CONFLICT');
  } finally { await db.close(); }
});

test('[SPM-177 AC4] Coordinator, Organiser and inactive Lead cannot assign or write effects', async () => {
  const db = await setup();
  try {
    const before = await snapshot(db);
    for (const actor of [1, 3, 5, 999]) {
      await assert.rejects(assign(db, 1, 3, actor), error => error.message === 'FORBIDDEN');
      assert.deepEqual(await snapshot(db), before);
    }
    for (const target of [1, 2, 4, 999]) {
      await assert.rejects(assign(db, 1, target), error => error.message === 'INVALID_COORDINATOR');
      assert.deepEqual(await snapshot(db), before);
    }
  } finally { await db.close(); }
});

test('[SPM-177] obsolete overload is removed and browser roles cannot execute assignment', async () => {
  const db = await setup();
  try {
    assert.equal((await db.query("SELECT to_regprocedure('public.assign_event_coordinator(integer,integer)') AS function")).rows[0].function, null);
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}`);
      await assert.rejects(assign(db), error => error.code === '42501');
      await db.exec('RESET ROLE');
    }
    await db.exec('SET ROLE service_role');
    await assign(db);
    await db.exec('RESET ROLE');
  } finally { await db.close(); }
});

test('[SPM-177 AC3] duplicate assignment and invalid starting states have no second effects', async () => {
  const db = await setup();
  try {
    await assign(db);
    const before = await snapshot(db);
    for (const event of [1, 4, 999]) {
      await assert.rejects(assign(db, event), error => error.message === 'EVENT_NOT_FOUND');
      assert.deepEqual(await snapshot(db), before);
    }
    assert.equal((await db.query("SELECT count(*)::int AS count FROM public.event WHERE event_id=1 AND status='SUBMITTED' AND coordinator_id IS NULL")).rows[0].count, 0);
  } finally { await db.close(); }
});

test('[SPM-177] half-open adjacent schedules succeed and overlap leaves everything unchanged', async () => {
  const db = await setup();
  try {
    await assign(db);
    await assign(db, 2);
    const before = await snapshot(db);
    await assert.rejects(assign(db, 3), error => error.message === 'COORDINATOR_CONFLICT');
    assert.deepEqual(await snapshot(db), before);
  } finally { await db.close(); }
});

test('[SPM-177 AC5] notification failure rolls back event, supervision, activity and notifications', async () => {
  const db = await setup();
  try {
    await db.exec("CREATE FUNCTION public.spm177_fail_recipient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced recipient failure'; END $$; CREATE TRIGGER spm177_fail_recipient BEFORE INSERT ON public.notification_recipient FOR EACH ROW EXECUTE FUNCTION public.spm177_fail_recipient()");
    const before = await snapshot(db);
    await assert.rejects(assign(db), /forced recipient failure/);
    assert.deepEqual(await snapshot(db), before);
  } finally { await db.close(); }
});
