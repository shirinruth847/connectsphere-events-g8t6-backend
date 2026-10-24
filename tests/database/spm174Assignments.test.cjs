const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const root=path.resolve(__dirname,'../..');
const migration=()=>fs.readFileSync(path.join(root,'supabase/migrations',fs.readdirSync(path.join(root,'supabase/migrations')).find(n=>n.endsWith('_spm174_lead_assignment_conflict_guard.sql'))),'utf8');
async function setup(){
 const db=new PGlite();
 await db.exec(fs.readFileSync(path.join(root,'tests/fixtures/spm36DatabaseSchema.sql'),'utf8'));
 await db.exec(`CREATE UNIQUE INDEX one_active_assignment ON public.event_assignments(event_id) WHERE ended_at IS NULL;
 INSERT INTO public."user"(user_id,email,name,role) VALUES
 (1,'spm174-owner@connectsphere.test','Owner','ORGANISER'),(2,'spm174-lead@connectsphere.test','Lead','COORDINATOR_LEAD'),
 (3,'spm174-a@connectsphere.test','A','COORDINATOR'),(4,'spm174-b@connectsphere.test','B','COORDINATOR'),(5,'spm174-other@connectsphere.test','Other Lead','COORDINATOR_LEAD');
 INSERT INTO public.event(event_id,organiser_id,coordinator_id,title,status,start_datetime,end_datetime) VALUES
 (1,1,3,'Owned conflict','PLANNING','2030-01-01T10:00Z','2030-01-01T12:00Z'),
 (2,1,3,'Legacy conflict','PLANNING','2030-01-01T11:00Z','2030-01-01T13:00Z'),
 (3,1,4,'Other Lead event','PLANNING','2030-01-02T10:00Z','2030-01-02T12:00Z');
 INSERT INTO public.event_assignments(event_id,coordinator_id,assigned_by) VALUES(1,3,2),(3,4,5);`);
 await db.exec(migration());return db;
}
const rpc=(db,id=1,lead=2,target=4,expected=3)=>db.query('SELECT public.reassign_event_coordinator($1,$2,$3,$4) AS result',[id,target,expected,lead]);
const snapshot=async db=>({events:(await db.query('SELECT * FROM public.event ORDER BY event_id')).rows,history:(await db.query('SELECT * FROM public.event_assignments ORDER BY assignment_id')).rows,activity:(await db.query('SELECT * FROM public.activity_log')).rows,notifications:(await db.query('SELECT * FROM public.notification')).rows,recipients:(await db.query('SELECT * FROM public.notification_recipient')).rows});

test('[SPM-174] migration preserves legacy conflicts; scoped list identifies them without exposing other supervision',async()=>{
 const db=await setup();try{
  const {rows}=await db.query('SELECT public.list_lead_event_assignments(2) AS result');
  assert.deepEqual(rows[0].result.map(e=>e.eventId),[1,2]);
  assert.ok(rows[0].result.every(e=>e.hasScheduleConflict));
  assert.equal(rows[0].result[1].supervisingLeadId,null);
  assert.equal((await db.query('SELECT coordinator_id FROM public.event WHERE event_id=1')).rows[0].coordinator_id,3);
  await assert.rejects(db.query('SELECT public.list_lead_event_assignments(3)'),e=>e.message==='FORBIDDEN');
  await db.exec('SET ROLE authenticated');
  await assert.rejects(db.query('SELECT public.list_lead_event_assignments(2)'),e=>e.code==='42501');
  await db.exec('RESET ROLE');
 }finally{await db.close();}
});
test('[SPM-174] successful reassignment atomically updates ownership history and exactly three notification recipients',async()=>{
 const db=await setup();try{
  const result=(await rpc(db)).rows[0].result;
  assert.equal(result.event.coordinator_id,4);assert.equal(result.event.status,'PLANNING');
  const state=await snapshot(db);
  assert.equal(state.history.filter(a=>a.event_id===1&&a.ended_at===null).length,1);
  assert.equal(state.history.find(a=>a.event_id===1&&a.ended_at===null).assigned_by,2);
  assert.equal(state.activity[0].action,'COORDINATOR_REASSIGNED');assert.equal(state.activity[0].audience,'STAFF_ONLY');
  assert.deepEqual(state.recipients.map(r=>r.recipient_id).sort(),[1,3,4]);
  await assert.rejects(rpc(db),e=>e.message==='ASSIGNMENT_CHANGED');
  assert.deepEqual(await snapshot(db),state);
 }finally{await db.close();}
});
test('[SPM-174] other Leads cannot change supervised events; legacy reassignment records its new supervising Lead',async()=>{
 const db=await setup();try{
  const before=await snapshot(db);
  await assert.rejects(rpc(db,1,5),e=>e.message==='EVENT_NOT_REASSIGNABLE');
  assert.deepEqual(await snapshot(db),before);
  await rpc(db,2,5);
  assert.equal((await db.query('SELECT assigned_by FROM public.event_assignments WHERE event_id=2 AND ended_at IS NULL')).rows[0].assigned_by,5);
 }finally{await db.close();}
});
test('[SPM-174] new direct writes cannot introduce clashes; adjacent events and unchanged legacy edits work',async()=>{
 const db=await setup();try{
  await db.query("UPDATE public.event SET title='Reviewed legacy event' WHERE event_id=1");
  await assert.rejects(db.query("UPDATE public.event SET coordinator_id=3 WHERE event_id=3" ).then(()=>db.query("UPDATE public.event SET start_datetime='2030-01-01T11:30Z',end_datetime='2030-01-01T12:30Z' WHERE event_id=3")),e=>e.message==='COORDINATOR_CONFLICT');
  await db.query("UPDATE public.event SET coordinator_id=3,start_datetime='2030-01-01T13:00Z',end_datetime='2030-01-01T14:00Z' WHERE event_id=3");
 }finally{await db.close();}
});
test('[SPM-174] conflict and recipient failure both roll back event, assignment, activity and notifications',async()=>{
 const db=await setup();try{
  await db.query("UPDATE public.event SET start_datetime='2030-01-01T10:00Z',end_datetime='2030-01-01T12:00Z' WHERE event_id=3");
  let before=await snapshot(db);
  await assert.rejects(rpc(db),e=>e.message==='COORDINATOR_CONFLICT');assert.deepEqual(await snapshot(db),before);
  await db.query("UPDATE public.event SET start_datetime='2030-01-02T10:00Z',end_datetime='2030-01-02T12:00Z' WHERE event_id=3");
  await db.exec("CREATE FUNCTION public.spm174_fail_recipient() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced recipient failure'; END; $$; CREATE TRIGGER spm174_fail_recipient BEFORE INSERT ON public.notification_recipient FOR EACH ROW EXECUTE FUNCTION public.spm174_fail_recipient()");
  before=await snapshot(db);
  await assert.rejects(rpc(db),/forced recipient failure/);assert.deepEqual(await snapshot(db),before);
 }finally{await db.close();}
});
