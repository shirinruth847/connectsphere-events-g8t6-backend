// Real MongoDB queries and validator on a local disposable server only.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {MongoMemoryServer}=require('mongodb-memory-server');
const {ObjectId}=require('mongodb');
const {getMongoDb,closeMongoDb}=require('../../config/mongodb');
const calendar=require('../../model/venueCalendarModel');
const migration=require('../../mongodb/migrations/0008_venue_hold_reminder_progress');
const schema=require('../../mongodb/schemas/venue_calendar.json');

test('reminder batches advance, expired holds stay eligible, stale acknowledgements cannot alter extensions',async t=>{
  const server=await MongoMemoryServer.create();
  const previous={uri:process.env.MONGODB_URI,db:process.env.MONGODB_DB_NAME};
  process.env.MONGODB_URI=server.getUri();process.env.MONGODB_DB_NAME='synthetic_hold_progress';
  t.after(async()=>{await closeMongoDb();await server.stop();process.env.MONGODB_URI=previous.uri;process.env.MONGODB_DB_NAME=previous.db;});
  const db=await getMongoDb();
  await db.createCollection('venue_calendar',{validator:schema,validationLevel:'strict',validationAction:'error'});
  await migration.up(db);
  const now=new Date();const expiry=new Date(+now+3600000);
  const docs=Array.from({length:101},()=>({_id:new ObjectId(),venueId:'7',type:'HOLD',status:'ACTIVE',eventId:1,
    start:new Date(+now+10*86400000),end:new Date(+now+10*86400000+3600000),
    occupiedStart:new Date(+now+10*86400000),occupiedEnd:new Date(+now+10*86400000+3600000),
    holdExpiresAt:expiry,createdAt:now,version:1}));
  await db.collection('venue_calendar').insertMany(docs);
  const until=new Date(+now+86400000);
  const first=await calendar.findHoldsExpiringBy(until,{now,limit:100});assert.equal(first.length,100);
  for(const h of first)assert.equal(await calendar.acknowledgeHoldNotice({holdId:h.id,expectedVersion:1,expiresAt:expiry,kind:'EXPIRING'}),true);
  const second=await calendar.findHoldsExpiringBy(until,{now,limit:100});assert.equal(second.length,1);
  const h=second[0];await calendar.acknowledgeHoldNotice({holdId:h.id,expectedVersion:1,expiresAt:expiry,kind:'EXPIRING'});
  assert.equal((await calendar.findHoldsExpiringBy(until,{now,limit:100})).length,0);
  const nextExpiry=new Date(+expiry+86400000);
  await db.collection('venue_calendar').updateOne({_id:new ObjectId(h.id)},{$set:{holdExpiresAt:nextExpiry,extendedAt:now},$inc:{version:1}});
  assert.equal(await calendar.acknowledgeHoldNotice({holdId:h.id,expectedVersion:1,expiresAt:expiry,kind:'EXPIRED'}),false);
  assert.equal((await calendar.findCalendarEntry(h.id)).status,'ACTIVE');
  // The old reminder marker does not suppress the reminder for the new expiry.
  const later=new Date(+now+2*3600000);
  assert.equal((await calendar.findHoldsExpiringBy(new Date(+later+86400000),{now:later,limit:200})).some(x=>x.id===h.id),true);
  // Already-reminded overdue holds must still be selected for expiry.
  const overdue=new Date(+expiry+1);
  assert.equal((await calendar.findHoldsExpiringBy(new Date(+overdue+86400000),{now:overdue,limit:200})).length,101);
  assert.equal(await calendar.acknowledgeHoldNotice({holdId:first[0].id,expectedVersion:1,expiresAt:expiry,kind:'EXPIRED'}),true);
  assert.equal((await calendar.findCalendarEntry(first[0].id)).status,'EXPIRED');
  assert.equal((await db.collection('venue_calendar').indexes()).some(x=>x.name==='hold_expiry_work'),true);
});
