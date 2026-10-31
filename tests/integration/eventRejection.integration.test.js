// Explicitly authorised development fixtures only. Never run against production.
const crypto = require('node:crypto');
const request = require('supertest');
const app = require('../../server');
const {newRunId,createAuthFixtures,cleanupAuthFixtures}=require('../fixtures/authFixtures');
const {createLifecycleEvent,cleanupLifecycleRows,withPrivilegedDb}=require('../fixtures/lifecycleFixtures');
const {signInWithPassword}=require('../fixtures/browserAuthClient');
const suite=process.env.SPM40_LIVE_TESTS==='authorized'?describe:describe.skip;

suite('SPM-40 live Auth/API/database integration',()=>{
  jest.setTimeout(180000);
  const runId=newRunId();let fixtures;const ids=[];const tokens={};
  const reason='Venue capacity is insufficient. Please revise the request.';
  const create=async(overrides={})=>{
    const event=await createLifecycleEvent(fixtures,{status:'UNDER_REVIEW',purpose:'SPM-40 live synthetic test',...overrides});ids.push(event.event_id);return event;
  };
  const reject=(event,key=crypto.randomUUID(),notes=reason,token=tokens.coordinator)=>request(app).post(`/api/events/${event.event_id}/reject`)
    .set('Authorization',`Bearer ${token}`).set('Idempotency-Key',key).send({version:event.version,reason:notes});
  const effects=eventId=>withPrivilegedDb(async client=>(await client.query(`SELECT
    (SELECT count(*)::int FROM activity_log WHERE entity_name='event' AND entity_id=$1 AND action='EVENT_REJECTED') AS audit,
    (SELECT count(*)::int FROM notification WHERE event_id=$1 AND title='Event request rejected') AS notices`,[eventId])).rows[0]);
  beforeAll(async()=>{
    const project='rvwiflsedoujspmzfrbq';
    if(!process.env.SUPABASE_URL?.includes(project) || !process.env.TEST_DATABASE_URL?.includes(project)) {
      throw new Error('Live SPM-40 tests are restricted to the explicitly authorised development project.');
    }
    await require('../fixtures/adminCleanup').assertAuditCleanupAvailable();
    await withPrivilegedDb(async client=>{
      const {rows}=await client.query("SELECT to_regprocedure('public.reject_submitted_event(integer,integer,integer,text,text,text)') AS fn");
      if(!rows[0].fn)throw new Error('SPM-40 migration is required before fixtures are created.');
    });
    fixtures=await createAuthFixtures(runId);
    for(const key of ['coordinator','organiserA','coordinatorTwo']){
      const {session,error}=await signInWithPassword(fixtures.accounts[key].email,fixtures.accounts[key].password);
      if(error||!session)throw new Error(`Synthetic ${key} sign-in failed.`);
      tokens[key]=session.access_token;
    }
  });
  afterAll(async()=>{
    try{if(fixtures)await cleanupLifecycleRows(runId,[...Object.values(fixtures.events),...ids]);}
    finally{await cleanupAuthFixtures(runId);}
  });
  test('rejection is persisted, replayed once, and visible to owner in detail/history/notifications',async()=>{
    const event=await create();const key=crypto.randomUUID();
    expect((await reject(event,key)).status).toBe(200);
    const replay=await reject(event,key);expect(replay.status).toBe(200);expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await effects(event.event_id)).toEqual({audit:1,notices:1});
    const detail=await request(app).get(`/api/events/${event.event_id}`).set('Authorization',`Bearer ${tokens.organiserA}`);
    expect(detail.status).toBe(200);expect(detail.body.event).toMatchObject({statusLabel:'Rejected',rejectionReason:reason});
    const history=await request(app).get(`/api/events/${event.event_id}/history`).set('Authorization',`Bearer ${tokens.organiserA}`);
    expect(history.status).toBe(200);
    expect(history.body.history).toEqual(expect.arrayContaining([expect.objectContaining({action:'EVENT_REJECTED',summary:reason,actor:expect.objectContaining({userId:fixtures.accounts.coordinator.userId})})]));
    await withPrivilegedDb(async client=>{
      const {rows}=await client.query(`SELECT n.message,r.recipient_id,a.timestamp FROM notification n
        JOIN notification_recipient r USING(notification_id)
        JOIN activity_log a ON a.entity_name='event' AND a.entity_id=n.event_id AND a.action='EVENT_REJECTED'
        WHERE n.event_id=$1 AND n.title='Event request rejected'`,[event.event_id]);
      expect(rows).toHaveLength(1);expect(rows[0].message).toContain(reason);expect(rows[0].recipient_id).toBe(fixtures.accounts.organiserA.userId);expect(rows[0].timestamp).toBeTruthy();
    });
    expect((await reject(event,key,'Another valid rejection reason.')).status).toBe(409);
  });
  test.each(['','123456789'])('invalid note %j has no side effects',async notes=>{
    const event=await create();expect((await reject(event,crypto.randomUUID(),notes)).status).toBe(400);
    expect(await effects(event.event_id)).toEqual({audit:0,notices:0});
  });
  test('exactly ten characters pass; owner/unrelated coordinator/unsigned calls are refused',async()=>{
    const event=await create();
    expect((await reject(event,crypto.randomUUID(),reason,tokens.organiserA)).status).toBe(403);
    expect((await reject(event,crypto.randomUUID(),reason,tokens.coordinatorTwo)).status).toBe(404);
    expect((await request(app).post(`/api/events/${event.event_id}/reject`).send({version:event.version,reason})).status).toBe(401);
    expect((await reject(event,crypto.randomUUID(),'1234567890')).status).toBe(200);
  });
  test.each(['REJECTED','CANCELLED','PLANNING'])('refuses %s without effects',async status=>{
    const event=await create({status});expect((await reject(event)).status).toBe(409);
    expect(await effects(event.event_id)).toEqual({audit:0,notices:0});
  });
  test.each([true,false])('separate connections serialize simultaneous rejection, same key=%s',async sameKey=>{
    const event=await create();const key=crypto.randomUUID();const hash=crypto.createHash('sha256').update(`${event.event_id}:spm40`).digest('hex');
    await withPrivilegedDb(async first=>withPrivilegedDb(async second=>{
      const sql='SELECT public.reject_submitted_event($1,$2,$3,$4,$5,$6) AS result';
      const args=[event.event_id,fixtures.accounts.coordinator.userId,event.version,reason,key,hash];
      await first.query('BEGIN');let waiting;
      try{
        await first.query('SELECT event_id FROM event WHERE event_id=$1 FOR UPDATE',[event.event_id]);
        const other=[...args];if(!sameKey)other[4]=crypto.randomUUID();
        waiting=second.query(sql,other).then(result=>({result}),error=>({error}));
        expect((await first.query(sql,args)).rows[0].result.replayed).toBe(false);
        await first.query('COMMIT');const outcome=await waiting;
        if(sameKey)expect(outcome.result.rows[0].result.replayed).toBe(true);
        else expect(outcome.error.message).toBe('EVENT_VERSION_CONFLICT');
      }finally{await first.query('ROLLBACK');if(waiting)await waiting;}
    }));
    expect(await effects(event.event_id)).toEqual({audit:1,notices:1});
  });
});
