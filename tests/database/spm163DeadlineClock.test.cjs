// Isolated elapsed-transaction regressions; hosted lock waits are separate tests.
const {before,test}=require('node:test');
const assert=require('node:assert/strict');
const f=require('../fixtures/waitlistDatabase');
before(f.openWaitlistDatabase);
const transaction=async work=>{await f.query('BEGIN');try{await work()}finally{await f.query('ROLLBACK')}};
const pause=()=>f.query('SELECT pg_sleep(0.2)');
const snapshot=async eventId=>(await f.query(`SELECT
 (SELECT count(*) FROM registration WHERE event_id=$1) registrations,
 (SELECT count(*) FROM activity_log) activity,
 (SELECT count(*) FROM notification WHERE event_id=$1) notifications,
 (SELECT count(*) FROM idempotency_records) keys`,[eventId])).rows[0];

test('offer acceptance rejects expiry crossed during an existing transaction without writes',async()=>{
 const id=await f.fullEventWithQueue([f.B]);await f.withdraw(f.A,id);const offer=await f.openOfferOf(f.B,id);
 await transaction(async()=>{await f.query("UPDATE waitlist_offer SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE offer_id=$1",[offer.offer_id]);await pause();
 assert.equal((await f.one('SELECT clock_timestamp()>expires_at crossed FROM waitlist_offer WHERE offer_id=$1',[offer.offer_id])).crossed,true);
 const before=await snapshot(id);await f.query('SAVEPOINT attempt');
 await assert.rejects(f.accept(f.B,id,offer.offer_id),/OFFER_EXPIRED/);await f.query('ROLLBACK TO SAVEPOINT attempt');
 assert.deepEqual(await snapshot(id),before);assert.equal((await f.placeOf(f.B,id)).registration_status,'WAITLISTED');});
});
test('withdrawal rejects event start crossed during an existing transaction without writes',async()=>{
 const id=await f.createEvent();await f.register(f.A,id);
 await transaction(async()=>{await f.query("UPDATE event SET start_datetime=clock_timestamp()+interval '100 milliseconds' WHERE event_id=$1",[id]);await pause();const before=await snapshot(id);await f.query('SAVEPOINT attempt');
 await assert.rejects(f.withdraw(f.A,id),/EVENT_STARTED/);await f.query('ROLLBACK TO SAVEPOINT attempt');assert.deepEqual(await snapshot(id),before);assert.equal((await f.placeOf(f.A,id)).registration_status,'REGISTERED');});
});
test('late withdrawal uses fresh time when the 24-hour threshold is crossed',async()=>{
 const id=await f.createEvent();await f.register(f.A,id);
 await transaction(async()=>{await f.query("UPDATE event SET start_datetime=clock_timestamp()+interval '24 hours 100 milliseconds' WHERE event_id=$1",[id]);await pause();
 const result=await f.withdraw(f.A,id);assert.equal(result.registration.late_withdrawal,true);
 assert.equal((await f.noticesFor(f.ORGANISER,id)).some(n=>n.title==='Late withdrawal'),true);
 assert.equal((await f.one('SELECT withdrawal_date>now() fresh FROM registration WHERE registration_id=$1',[result.registration.registration_id])).fresh,true);});
});
test('successful acceptance replay remains valid after offer expiry',async()=>{
 const id=await f.fullEventWithQueue([f.B]);await f.withdraw(f.A,id);const offer=await f.openOfferOf(f.B,id);
 const call=()=>f.one("SELECT accept_waitlist_offer($1,$2,$3,'clock-accept-key',$4) result",[f.B,id,offer.offer_id,'a'.repeat(64)]);
 const first=await call();await f.query("UPDATE waitlist_offer SET expires_at=clock_timestamp()-interval '1 second',offered_at=clock_timestamp()-interval '1 hour' WHERE offer_id=$1",[offer.offer_id]);
 const replay=await call();assert.equal(replay.result.replayed,true);assert.equal(replay.result.registration.registration_id,first.result.registration.registration_id);
});
test('successful withdrawal replay remains valid after the event starts',async()=>{
 const id=await f.createEvent();await f.register(f.A,id);const first=await f.withdraw(f.A,id,'clock-withdraw-key');
 await f.query("UPDATE event SET start_datetime=clock_timestamp()-interval '1 second' WHERE event_id=$1",[id]);const replay=await f.withdraw(f.A,id,'clock-withdraw-key');
 assert.equal(replay.replayed,true);assert.equal(replay.registration.registration_id,first.registration.registration_id);
});
