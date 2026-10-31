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
// The newest migration that defines `name`, so later changes to it are tested.
const newestDefining = (name) => {
  const pattern = new RegExp(`CREATE(?: OR REPLACE)? FUNCTION public\\.${name}\\(`);
  const files = fs.readdirSync(path.join(root, "supabase/migrations")).filter((file) => file.endsWith(".sql")).sort().reverse();
  const file = files.find((candidate) => pattern.test(read(candidate)));
  assert.ok(file, `Missing migration for ${name}`);
  return read(file);
};
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
  // The four-argument transition and notification overloads used here are only defined in the SPM-173 migration.
  await db.exec(extract(newestDefining("_lifecycle_transitions"), "_lifecycle_transitions"));
  for (const name of ["_check_event_transition", "_apply_event_transition", "_notify_event_users"]) await db.exec(extract(lifecycle, name));
  await db.exec(extract(versioning, "_bump_event_version"));
  await db.exec("CREATE TRIGGER event_bump_version BEFORE UPDATE ON public.event FOR EACH ROW EXECUTE FUNCTION public._bump_event_version()");
  await db.exec(read("20261026190415_spm39_accept_feasibility.sql"));
  await db.exec(read("20261030022851_spm40_reject_submitted_event.sql"));
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
const reject = async (db, { actor=2, version=1, reason="Reason text", key="spm40-key-0001", hash="a".repeat(64) }={}) =>
  (await db.query("SELECT public.reject_submitted_event(1,$1,$2,$3,$4,$5) AS result",[actor,version,reason,key,hash])).rows[0].result;
const counts = async db => (await db.query(`SELECT
  (SELECT count(*)::int FROM activity_log) AS audit,
  (SELECT count(*)::int FROM notification) AS notices,
  (SELECT count(*)::int FROM idempotency_records) AS replays`)).rows[0];
test("SPM-40 rejection", async t => {
  await t.test("10-character boundary persists rejection, actor, timestamp, reason and owner notification once", async () => {
    const db=await setup(); try {
      const before=Date.now();
      const result=await reject(db);
      assert.equal(result.event.status,"REJECTED"); assert.equal(result.event.version,2);
      assert.equal((await reject(db)).replayed,true);
      assert.deepEqual(await counts(db),{audit:1,notices:1,replays:1});
      const row=(await db.query('SELECT user_id,action,details,changes,"timestamp" FROM activity_log')).rows[0];
      assert.equal(row.user_id,2); assert.equal(row.action,"EVENT_REJECTED"); assert.equal(row.details,"Reason text");
      assert.deepEqual(row.changes,{status:{before:"UNDER_REVIEW",after:"REJECTED"}});
      assert.ok(new Date(row.timestamp).getTime()>=before);
      assert.match((await db.query("SELECT message FROM notification")).rows[0].message,/Reason text/);
      assert.equal((await db.query("SELECT recipient_id FROM notification_recipient")).rows[0].recipient_id,1);
      await assert.rejects(reject(db,{hash:"b".repeat(64)}),/IDEMPOTENCY_KEY_REUSED/);
      await db.exec("UPDATE event SET coordinator_id=3");
      await assert.rejects(reject(db),/EVENT_NOT_FOUND/);
    } finally { await db.close(); }
  });
  for(const reason of [null,"", "   ","123456789","a".repeat(2001)]) await t.test(`invalid note ${String(reason).slice(0,15)}`,async()=>{
    const db=await setup();try{
      await assert.rejects(reject(db,{reason}),/INVALID_REJECTION_REASON/);
      assert.equal((await db.query("SELECT status FROM event")).rows[0].status,"UNDER_REVIEW");
      assert.deepEqual(await counts(db),{audit:0,notices:0,replays:0});
    }finally{await db.close();}
  });
  for(const reason of ["a".repeat(2000),"😀".repeat(10),"  1234567890  "]) await t.test(`valid boundary note ${Array.from(reason).length}`,async()=>{
    const db=await setup();try{
      assert.equal((await reject(db,{reason})).event.status,"REJECTED");
      assert.equal((await db.query("SELECT details FROM activity_log")).rows[0].details,reason.trim());
    }finally{await db.close();}
  });
  await t.test("missing key/version and nonexistent event are refused without effects",async()=>{
    const db=await setup();try{
      await assert.rejects(reject(db,{key:null}),/IDEMPOTENCY_KEY_REQUIRED/);
      await assert.rejects(reject(db,{version:null}),/INVALID_EVENT_PATCH/);
      await db.exec("DELETE FROM event_venue_preference; DELETE FROM event");
      await assert.rejects(reject(db),/EVENT_NOT_FOUND/);
      assert.deepEqual(await counts(db),{audit:0,notices:0,replays:0});
    }finally{await db.close();}
  });
  for(const status of ["DRAFT","SUBMITTED","AWAITING_CLARIFICATION","PLANNING","SAFETY_REVIEW","CONFIRMED","REJECTED","CANCELLED","COMPLETED"]) await t.test(`refuses ${status}`,async()=>{
    const db=await setup();try{
      await db.query("UPDATE event SET status=$1",[status]);
      await assert.rejects(reject(db,{version:2}),/TRANSITION_NOT_ALLOWED/);
      assert.equal((await db.query("SELECT status FROM event")).rows[0].status,status);
      assert.deepEqual(await counts(db),{audit:0,notices:0,replays:0});
    }finally{await db.close();}
  });
  await t.test("stale, unrelated, inactive and wrong role are refused",async()=>{
    const db=await setup();try{
      await assert.rejects(reject(db,{version:9}),/EVENT_VERSION_CONFLICT/);
      await assert.rejects(reject(db,{actor:3}),/EVENT_NOT_FOUND/);
      await db.exec('UPDATE public."user" SET is_active=false WHERE user_id=2');
      await assert.rejects(reject(db),/FORBIDDEN/);
      await db.exec(`UPDATE public."user" SET is_active=true,role='COORDINATOR_LEAD' WHERE user_id=2`);
      await assert.rejects(reject(db),/FORBIDDEN/);
    }finally{await db.close();}
  });
  await t.test("formerly confirmed requests cannot be rejected",async()=>{
    const db=await setup();try{
      await db.exec("UPDATE event SET previously_confirmed=true");
      await assert.rejects(reject(db,{version:2}),/TRANSITION_NOT_ALLOWED/);
      assert.deepEqual(await counts(db),{audit:0,notices:0,replays:0});
    }finally{await db.close();}
  });
  for(const table of ["activity_log","notification_recipient"]) await t.test(`rollback on ${table}`,async()=>{
    const db=await setup();try{
      await db.exec(`CREATE FUNCTION fail_spm40() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$; CREATE TRIGGER fail_spm40 BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_spm40()`);
      await assert.rejects(reject(db),/forced failure/);
      assert.equal((await db.query("SELECT status FROM event")).rows[0].status,"UNDER_REVIEW");
      assert.deepEqual(await counts(db),{audit:0,notices:0,replays:0});
    }finally{await db.close();}
  });
  for(const first of ["approve","reject"]) await t.test(`SPM-39/40: ${first} prevents the opposite decision`,async()=>{
    const db=await setup();try{
      const approve=()=>db.query("SELECT public.accept_event_feasibility(1,2,1,'spm39-combined-0001',$1)",["b".repeat(64)]);
      if(first==="approve"){
        await approve();
        await assert.rejects(reject(db,{version:2}),/TRANSITION_NOT_ALLOWED/);
      }else{
        await reject(db);
        await assert.rejects(approve(),/EVENT_VERSION_CONFLICT|TRANSITION_NOT_ALLOWED/);
      }
      assert.deepEqual(await counts(db),{audit:1,notices:1,replays:1});
      assert.equal((await db.query("SELECT status FROM event")).rows[0].status,first==="approve"?"PLANNING":"REJECTED");
    }finally{await db.close();}
  });
  await t.test("browser execution denied",async()=>{
    const db=await setup();try{
      for(const role of ["anon","authenticated"]) assert.equal((await db.query("SELECT has_function_privilege($1,'public.reject_submitted_event(integer,integer,integer,text,text,text)','EXECUTE') AS allowed",[role])).rows[0].allowed,false);
    }finally{await db.close();}
  });
});
