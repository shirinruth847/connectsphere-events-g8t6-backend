// Isolated PostgreSQL engine. Real hold guards, conflict helper and durable
// claim functions; notification capture replaces the existing notifier only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const root = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(root, 'supabase/migrations', name), 'utf8');
const fn = (source, name) => source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0];
async function setup(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE venue_calendar_writer;
    CREATE TABLE public.event(event_id integer PRIMARY KEY,status text,start_datetime timestamptz,end_datetime timestamptz,coordinator_id integer);
    CREATE TABLE public.venue(venue_id integer PRIMARY KEY,name text,is_active boolean,status text,max_capacity integer DEFAULT 200);
    CREATE TABLE public."user"(user_id integer PRIMARY KEY,role text,is_active boolean);
    CREATE TABLE public.venue_booking(booking_id integer,event_id integer,venue_id integer,status text,start_datetime timestamptz,end_datetime timestamptz,occupied_range tstzrange);
    CREATE TABLE public.idempotency_records(operation text CONSTRAINT idempotency_records_operation_check CHECK(operation='previous.operation'));
    CREATE FUNCTION public._require_venue_staff(integer) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM public."user" WHERE user_id=$1 AND role='VENUE_STAFF' AND is_active) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF; END $$;
    CREATE FUNCTION public._claim_idempotency_key(integer,text,text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$;
    INSERT INTO public."user" VALUES(4,'VENUE_STAFF',true),(5,'COORDINATOR',true);
    INSERT INTO public.event VALUES(1,'PLANNING','2030-11-04T08:00Z','2030-11-04T18:00Z',5),(2,'PLANNING','2030-11-04T08:00Z','2030-11-04T18:00Z',5);
    INSERT INTO public.venue(venue_id,name,is_active,status) VALUES(7,'Synthetic hall',true,'ACTIVE');`);
  await db.exec(fn(read('20261029140000_spm195_venue_blocks.sql'), '_venue_block_affected_bookings'));
  await db.exec(read('20261030143144_spm190_venue_holds.sql'));
  await db.exec(`CREATE TABLE public.captured_hold_notice(kind text,hold_id text);
    CREATE OR REPLACE FUNCTION public.notify_venue_hold_expiry(p_kind text,p_event_id integer,p_hold_id text,p_venue_id integer,p_expires_at timestamptz)
      RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.captured_hold_notice VALUES($1,$3); RETURN 1; END $$;
    INSERT INTO public.venue_hold_request(event_id,venue_id,label,start_datetime,end_datetime,requested_by)
      VALUES(1,7,'Synthetic hold','2030-11-04T13:00Z','2030-11-04T14:00Z',5);`);
  await db.transaction(tx => tx.exec(read('20261031040000_spm190_hold_review_fixes.sql')));
  await db.transaction(tx => tx.exec(read('20261031050000_spm190_hold_placement_recovery.sql')));
  await db.transaction(tx => tx.exec(read('20261031060000_spm190_hold_capacity_guard.sql')));
  return db;
}
const begin = db => db.query("SELECT public.begin_venue_hold_placement(4,1,'2030-11-04T12:30Z','2030-11-04T14:45Z','key','hash') AS result");
const record = (db, kind, expiry) => db.query("SELECT public.record_venue_hold_expiry($1,1,$2,7,$3) AS claimed", [kind,'a'.repeat(24),expiry]);
const count = async (db, table) => (await db.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n;

test('legacy pending and approved bookings retain turnaround; exact adjacency is allowed', async t => {
  const db = await setup(t);
  for (const status of ['PENDING','APPROVED']) {
    await db.exec('DELETE FROM public.venue_booking');
    await db.query("INSERT INTO public.venue_booking VALUES(1,2,7,$1,'2030-11-04T10:00Z','2030-11-04T12:00Z',NULL)",[status]);
    const r = (await begin(db)).rows[0].result;
    assert.equal(r.bookingConflicts.length,1);
    assert.equal(r.bookingConflicts[0].occupiedEnd,'2030-11-04T12:45:00+00:00');
  }
  await db.exec("UPDATE public.venue_booking SET end_datetime='2030-11-04T11:45Z'");
  assert.equal((await begin(db)).rows[0].result.bookingConflicts.length,0);
  // Stored ranges are authoritative even when raw times would not overlap.
  await db.exec("UPDATE public.venue_booking SET occupied_range=tstzrange('2030-11-04T09:00Z','2030-11-04T12:31Z','[)')");
  assert.equal((await begin(db)).rows[0].result.bookingConflicts.length,1);
});

test('placement rechecks a changed event window and keeps the request pending on refusal', async t => {
  const db = await setup(t);
  await db.exec("UPDATE public.event SET end_datetime='2030-11-04T12:00Z' WHERE event_id=1");
  await assert.rejects(begin(db),/HOLD_OUTSIDE_EVENT/);
  assert.equal((await db.query('SELECT status FROM public.venue_hold_request')).rows[0].status,'PENDING');
});

test('malformed occupied bounds and unauthorized actors are refused', async t => {
  const db = await setup(t);
  await assert.rejects(db.query("SELECT public.begin_venue_hold_placement(4,1,'2030-11-04T13:01Z','2030-11-04T14:45Z','key','hash')"),/INVALID_HOLD/);
  await assert.rejects(db.query("SELECT public.begin_venue_hold_placement(5,1,'2030-11-04T12:30Z','2030-11-04T14:45Z','key','hash')"),/FORBIDDEN/);
});

test('durable claims survive replay and separately claim an extended expiry', async t => {
  const db = await setup(t);
  const now = new Date((await db.query('SELECT public.venue_hold_clock() now')).rows[0].now);
  for (const expiry of [new Date(+now+3600000),new Date(+now+7200000)]) {
    assert.equal((await record(db,'EXPIRING',expiry)).rows[0].claimed,true);
    assert.equal((await record(db,'EXPIRING',expiry)).rows[0].claimed,false);
  }
  assert.equal(await count(db,'captured_hold_notice'),2);
  assert.equal(await count(db,'venue_hold_notice_claim'),2);
  assert.equal((await record(db,'EXPIRED',new Date(+now+3600000))).rows[0].claimed,false);
  assert.equal((await record(db,'EXPIRING',new Date(+now-1000))).rows[0].claimed,false);
  assert.equal((await record(db,'EXPIRING',new Date(+now+25*3600000))).rows[0].claimed,false);
});

test('notification failure rolls back its claim; retry can record exactly once', async t => {
  const db = await setup(t);
  await db.exec(`CREATE FUNCTION fail_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic notification failure'; END $$;
    CREATE TRIGGER fail_notice BEFORE INSERT ON public.captured_hold_notice FOR EACH ROW EXECUTE FUNCTION fail_notice();`);
  const expiry = new Date(Date.now()-60000);
  await assert.rejects(record(db,'EXPIRED',expiry),/synthetic notification failure/);
  assert.equal(await count(db,'venue_hold_notice_claim'),0);
  await db.exec('DROP TRIGGER fail_notice ON public.captured_hold_notice');
  assert.equal((await record(db,'EXPIRED',expiry)).rows[0].claimed,true);
  assert.equal((await record(db,'EXPIRED',expiry)).rows[0].claimed,false);
  assert.equal(await count(db,'captured_hold_notice'),1);
});

test('expiry functions and claim table are inaccessible to browser and service writers', async t => {
  const db = await setup(t);
  const r = (await db.query(`SELECT
    has_function_privilege('authenticated','public.record_venue_hold_expiry(text,integer,text,integer,timestamptz)','EXECUTE') browser,
    has_function_privilege('service_role','public.record_venue_hold_expiry(text,integer,text,integer,timestamptz)','EXECUTE') service,
    has_function_privilege('venue_calendar_writer','public.record_venue_hold_expiry(text,integer,text,integer,timestamptz)','EXECUTE') writer,
    has_table_privilege('service_role','public.venue_hold_notice_claim','INSERT') direct_write`)).rows[0];
  assert.deepEqual(r,{browser:false,service:false,writer:true,direct_write:false});
});


test('orphan recovery requires active Venue Staff, a pending request and no committed hold link', async t => {
  const db = await setup(t); const id = 'b'.repeat(24);
  const check = async actor => (await db.query('SELECT public.can_recover_venue_hold_placement($1,1,$2) recoverable',[actor,id])).rows[0].recoverable;
  assert.equal(await check(4),true);
  await assert.rejects(check(5),/FORBIDDEN/);
  await assert.rejects(db.query("SELECT public.can_recover_venue_hold_placement(4,1,'bad')"),/INVALID_HOLD/);
  await db.query(`INSERT INTO public.venue_hold_request(event_id,venue_id,label,start_datetime,end_datetime,requested_by,status,decided_by,decided_at,calendar_hold_id)
    VALUES(2,7,'Committed placement','2030-11-04T13:00Z','2030-11-04T14:00Z',5,'PLACED',4,now(),$1)`,[id]);
  assert.equal(await check(4),false);
  await db.exec("UPDATE public.venue_hold_request SET status='WITHDRAWN',decided_at=now(),decided_by=5 WHERE hold_request_id=1");
  assert.equal(await check(4),false);
  const grants = (await db.query(`SELECT
    has_function_privilege('authenticated','public.can_recover_venue_hold_placement(integer,integer,text)','EXECUTE') browser,
    has_function_privilege('service_role','public.can_recover_venue_hold_placement(integer,integer,text)','EXECUTE') service,
    has_function_privilege('venue_calendar_writer','public.can_recover_venue_hold_placement(integer,integer,text)','EXECUTE') writer`)).rows[0];
  assert.deepEqual(grants,{browser:false,service:false,writer:true});
});


test('placement rechecks capacity while locked; equality and optional attendance remain valid', async t => {
  const db = await setup(t);
  await db.exec('UPDATE public.venue_hold_request SET expected_attendance=50; UPDATE public.venue SET max_capacity=20');
  await assert.rejects(begin(db), /VENUE_CAPACITY_EXCEEDED/);
  assert.equal((await db.query('SELECT status FROM public.venue_hold_request')).rows[0].status, 'PENDING');
  await db.exec('UPDATE public.venue SET max_capacity=50');
  assert.ok((await begin(db)).rows[0].result.request);
  await db.exec('UPDATE public.venue SET max_capacity=20; UPDATE public.venue_hold_request SET expected_attendance=NULL');
  assert.ok((await begin(db)).rows[0].result.request);
  const grants = (await db.query(`SELECT
    has_function_privilege('authenticated','public.begin_venue_hold_placement(integer,integer,timestamptz,timestamptz,text,text)','EXECUTE') browser,
    has_function_privilege('service_role','public.begin_venue_hold_placement(integer,integer,timestamptz,timestamptz,text,text)','EXECUTE') service,
    has_function_privilege('venue_calendar_writer','public.begin_venue_hold_placement(integer,integer,timestamptz,timestamptz,text,text)','EXECUTE') writer`)).rows[0];
  assert.deepEqual(grants, {browser:false,service:false,writer:true});
});
