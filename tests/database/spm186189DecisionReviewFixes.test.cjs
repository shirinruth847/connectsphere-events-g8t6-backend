// Local PostgreSQL engine only. Real decision/lifecycle/supersession SQL;
// notification delivery is replaced by transactional capture, never a provider.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { btree_gist } = require("@electric-sql/pglite/contrib/btree_gist");
const root = path.resolve(__dirname, "../..");
const read = name => fs.readFileSync(path.join(root, "supabase/migrations", name), "utf8");
const fn = (source, name) => {
  const match = source.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(match, name);
  return match[0];
};
const correction = read("20261031020000_spm186_189_decision_review_fixes.sql");
const transitions = fn(read("20261024120000_spm41_clarification_threads.sql"), "_lifecycle_transitions");
async function setup(t, { eventStatus = "PLANNING", targetStatus = "PENDING", migrate = true } = {}) {
  const db = new PGlite({ extensions: { btree_gist } });
  t.after(() => db.close());
  await db.exec(fs.readFileSync(path.join(root, "tests/fixtures/spm177DatabaseSchema.sql"), "utf8"));
  await db.exec(`CREATE ROLE venue_calendar_writer;
    CREATE EXTENSION btree_gist;
    ALTER TABLE public.venue ADD COLUMN status text DEFAULT 'ACTIVE', ADD COLUMN status_reason text,
      ADD COLUMN version integer DEFAULT 1, ADD COLUMN updated_at timestamptz, ADD COLUMN updated_by integer;
    CREATE TYPE public.booking_status AS ENUM ('PENDING','APPROVED','REJECTED','CANCELLED');
    CREATE TABLE public.venue_booking(booking_id integer PRIMARY KEY,event_id integer REFERENCES public.event,
      room_id integer REFERENCES public.room,venue_id integer REFERENCES public.venue,status public.booking_status,
      start_datetime timestamptz,end_datetime timestamptz,expected_attendance integer,reviewed_by integer REFERENCES public."user",
      rejection_reason text,occupied_range tstzrange);
    ALTER TABLE public.venue_booking ADD CONSTRAINT venue_booking_no_overlap EXCLUDE USING gist
      (venue_id WITH =,occupied_range WITH &&) WHERE (status IN ('PENDING','APPROVED'));
    CREATE TABLE public.safety_reviews(review_id integer PRIMARY KEY,event_id integer,status text,
      claimed_by integer,round_number integer,superseded_at timestamptz);
    CREATE TABLE public.recorded_notices(event_id integer,title text,message text,recipients integer[]);
    CREATE FUNCTION public._notify_event_users(integer,text,text,integer[],text DEFAULT NULL,text DEFAULT NULL,jsonb DEFAULT NULL)
      RETURNS void LANGUAGE sql AS $$ INSERT INTO public.recorded_notices VALUES($1,$2,$3,$4) $$;
    CREATE TABLE public.registration(event_id integer,user_id integer,status text);
    CREATE TABLE public.event_confirmation_snapshots(event_id integer,snapshot jsonb);
    INSERT INTO public."user"(user_id,email,name,role) VALUES
      (2,'coordinator@example.test','Coordinator','COORDINATOR'),(3,'owner@example.test','Owner','ORGANISER'),
      (4,'staff@example.test','Staff','VENUE_STAFF'),(5,'attendee@example.test','Attendee','ATTENDEE');
    INSERT INTO public.venue(venue_id,name,address,max_capacity) VALUES(7,'Synthetic hall','Synthetic road',200),(8,'Synthetic annex','Synthetic road',100);
    INSERT INTO public.room(room_id,venue_id,layout_type,capacity) VALUES(70,7,'Theatre',200),(80,8,'Theatre',100);`);
  const lifecycle = read("20261019075510_spm173_lifecycle_transitions.sql");
  await db.exec(transitions);
  await db.exec(fn(lifecycle, "_check_event_transition"));
  await db.exec(fn(lifecycle, "_apply_event_transition"));
  const safety = read("20261020155952_spm250_supersede_safety_review.sql");
  await db.exec(fn(safety, "_close_safety_review_for_change"));
  await db.exec(fn(safety, "_supersede_safety_review"));
  await db.exec(fn(read("20261020090836_spm73_venue_catalogue_maintenance.sql"), "_require_venue_staff"));
  await db.exec(read("20261024100623_spm186_189_venue_booking_decisions.sql"));
  if (migrate) await db.transaction(tx => tx.exec(correction));
  await db.query(`INSERT INTO public.event(event_id,organiser_id,coordinator_id,title,status,expected_attendance,
    previously_confirmed,is_registration_enabled) VALUES(1,3,2,'Synthetic event',$1,100,$2,true),(2,3,2,'Other event','PLANNING',100,false,false)`,
    [eventStatus, ["CONFIRMED","PREPARATION"].includes(eventStatus)]);
  await db.query(`INSERT INTO public.venue_booking(booking_id,event_id,room_id,venue_id,status,start_datetime,end_datetime,expected_attendance)
    VALUES(10,1,70,7,$1,'2030-11-04T02:00Z','2030-11-04T04:00Z',100)`, [targetStatus]);
  return db;
}
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const decide = (db, decision, expected, reason = null, actor = 4) => db.query(
  "SELECT public.decide_venue_booking($1,10,$2,$3,$4,30,45)", [actor,decision,expected,reason]);
const refused = (promise, message) => assert.rejects(promise, error => error.message === message);

for (const status of ["PENDING","APPROVED"]) {
  test(`approval refuses an overlapping ${status} booking with null legacy ranges`, async t => {
    const db = await setup(t);
    await db.query(`INSERT INTO public.venue_booking(booking_id,event_id,room_id,venue_id,status,start_datetime,end_datetime)
      VALUES(11,2,70,7,$1,'2030-11-04T04:30Z','2030-11-04T06:00Z')`, [status]);
    await refused(decide(db,"APPROVE","PENDING"), "VENUE_BOOKING_CONFLICT");
    assert.equal((await one(db,"SELECT status FROM public.venue_booking WHERE booking_id=10")).status,"PENDING");
    assert.equal((await one(db,"SELECT count(*)::int n FROM public.recorded_notices")).n,0);
  });
}
test("adjacency succeeds but stored occupied ranges override recomputed buffers", async t => {
  const db = await setup(t);
  await db.exec(`INSERT INTO public.venue_booking(booking_id,event_id,room_id,venue_id,status,start_datetime,end_datetime,occupied_range)
    VALUES(11,2,70,7,'PENDING','2030-11-04T05:15Z','2030-11-04T06:00Z',tstzrange('2030-11-04T04:44Z','2030-11-04T06:45Z','[)'));`);
  await refused(decide(db,"APPROVE","PENDING"),"VENUE_BOOKING_CONFLICT");
  await db.exec("UPDATE public.venue_booking SET occupied_range=tstzrange('2030-11-04T04:45Z','2030-11-04T06:45Z','[)') WHERE booking_id=11");
  await decide(db,"APPROVE","PENDING");
  assert.equal((await one(db,"SELECT status FROM public.venue_booking WHERE booking_id=10")).status,"APPROVED");
});
for (const state of ["PLANNING","SAFETY_REVIEW","CONFIRMED","PREPARATION"]) {
  test(`withdrawal from ${state} returns/stays Planning and preserves related data`, async t => {
    const db = await setup(t,{eventStatus:state,targetStatus:"APPROVED"});
    await db.exec(`INSERT INTO public.venue_booking(booking_id,event_id,room_id,venue_id,status,start_datetime,end_datetime)
      VALUES(11,1,80,8,'APPROVED','2030-11-04T05:00Z','2030-11-04T06:00Z');
      INSERT INTO public.registration VALUES(1,5,'CONFIRMED');
      INSERT INTO public.event_confirmation_snapshots VALUES(1,'{"keep":true}');`);
    if(state==="SAFETY_REVIEW") await db.exec("INSERT INTO public.safety_reviews VALUES(1,1,'OPEN',NULL,1,NULL)");
    const before=await one(db,"SELECT * FROM public.event WHERE event_id=1");
    await decide(db,"REJECT","APPROVED","Roof repair; use Synthetic Annex instead");
    const after=await one(db,"SELECT * FROM public.event WHERE event_id=1");
    assert.equal(after.status,"PLANNING");assert.equal(after.arrangement_version,before.arrangement_version+1);
    for(const key of ["title","organiser_id","coordinator_id","previously_confirmed","is_registration_enabled"]) assert.deepEqual(after[key],before[key],key);
    assert.equal((await one(db,"SELECT status FROM public.venue_booking WHERE booking_id=11")).status,"APPROVED");
    assert.equal((await one(db,"SELECT status FROM public.registration WHERE event_id=1")).status,"CONFIRMED");
    assert.deepEqual((await one(db,"SELECT snapshot FROM public.event_confirmation_snapshots WHERE event_id=1")).snapshot,{keep:true});
    if(state==="SAFETY_REVIEW") assert.equal((await one(db,"SELECT status FROM public.safety_reviews WHERE review_id=1")).status,"SUPERSEDED");
    const notices=(await db.query("SELECT * FROM public.recorded_notices WHERE title='Venue no longer available' ORDER BY recipients")).rows;
    assert.equal(notices.length,2);assert.match(notices[0].message,/Roof repair/);assert.doesNotMatch(notices[1].message,/Roof repair/);
    assert.deepEqual(notices.flatMap(x=>x.recipients),[2,3]);
    const count=(await one(db,"SELECT count(*)::int n FROM public.activity_log")).n;
    await refused(decide(db,"REJECT","APPROVED","Retry"),"BOOKING_ALREADY_DECIDED");
    assert.equal((await one(db,"SELECT count(*)::int n FROM public.activity_log")).n,count);
  });
}
test("an audit failure rolls back booking, lifecycle, version and notification effects", async t => {
  const db=await setup(t,{eventStatus:"CONFIRMED",targetStatus:"APPROVED"});
  await db.exec(`CREATE FUNCTION fail_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='VENUE_BOOKING_REJECTED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_review_audit BEFORE INSERT ON public.activity_log FOR EACH ROW EXECUTE FUNCTION fail_review_audit();`);
  await refused(decide(db,"REJECT","APPROVED","Synthetic repair"),"synthetic audit failure");
  assert.equal((await one(db,"SELECT status FROM public.event WHERE event_id=1")).status,"CONFIRMED");
  assert.equal((await one(db,"SELECT arrangement_version FROM public.event WHERE event_id=1")).arrangement_version,1);
  assert.equal((await one(db,"SELECT status FROM public.venue_booking WHERE booking_id=10")).status,"APPROVED");
  assert.equal((await one(db,"SELECT count(*)::int n FROM public.activity_log")).n,0);
  assert.equal((await one(db,"SELECT count(*)::int n FROM public.recorded_notices")).n,0);
});
test("new lifecycle action retains existing transitions and refuses other roles", async t => {
  const db=await setup(t,{eventStatus:"CONFIRMED",targetStatus:"APPROVED"});
  const previous=(await db.query(`SELECT * FROM (${transitions.split('AS $$')[1].split('$$;')[0]}) AS t(action,from_states,to_state,actor_role,relationship,allows_system,activity_action,audience)`)).rows;
  const current=(await db.query("SELECT * FROM public._lifecycle_transitions()")).rows;
  for(const row of previous) assert.ok(current.some(x=>JSON.stringify(x)===JSON.stringify(row)),row.action);
  for(const actor of [2,3,5,null]) await refused(decide(db,"REJECT","APPROVED","Synthetic repair",actor),"FORBIDDEN");
});

test("migration fails atomically rather than discard another branch's lifecycle rule", async t => {
  const db=await setup(t,{migrate:false});
  const extra=transitions.replace("    ('venue_replacement',", "    ('other_branch_action', ARRAY['PLANNING'], 'PLANNING', 'COORDINATOR', 'ASSIGNED', false, 'OTHER_BRANCH_ACTION', 'STAFF_ONLY'),\n    ('venue_replacement',");
  await db.exec(extra);
  await assert.rejects(db.transaction(tx=>tx.exec(correction)),/LIFECYCLE_BASELINE_CHANGED/);
  assert.equal((await one(db,"SELECT count(*)::int n FROM public._lifecycle_transitions() WHERE action='other_branch_action'")).n,1);
  assert.equal((await one(db,"SELECT count(*)::int n FROM public._lifecycle_transitions() WHERE action='venue_approval_withdrawn'")).n,0);
});

test("started approvals cannot be withdrawn and pending rejection leaves its event state alone", async t => {
  const db=await setup(t,{eventStatus:"CONFIRMED",targetStatus:"APPROVED"});
  await db.exec("UPDATE public.venue_booking SET start_datetime=now()-interval '1 hour',end_datetime=now()+interval '1 hour' WHERE booking_id=10");
  await refused(decide(db,"REJECT","APPROVED","Synthetic repair"),"BOOKING_ALREADY_STARTED");
  assert.equal((await one(db,"SELECT status FROM public.event WHERE event_id=1")).status,"CONFIRMED");
  await db.exec("UPDATE public.event SET status='PLANNING' WHERE event_id=1; UPDATE public.venue_booking SET status='PENDING' WHERE booking_id=10");
  await decide(db,"REJECT","PENDING","Synthetic repair");
  assert.equal((await one(db,"SELECT status FROM public.event WHERE event_id=1")).status,"PLANNING");
  assert.equal((await one(db,"SELECT count(*)::int n FROM public.activity_log WHERE action='VENUE_APPROVAL_WITHDRAWN'")).n,0);
});
