// SPM-147 Withdraw Event Registration on an isolated in-memory PostgreSQL engine.
// Run: node --test tests/database/spm147Withdrawal.test.cjs
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  openWaitlistDatabase,
  ORGANISER,
  A,
  B,
  C,
  createEvent,
  register,
  withdraw,
  placeOf,
  offersFor,
  noticesFor,
  visible,
  fullEventWithQueue,
  availabilityOf,
  one,
} = require("../fixtures/waitlistDatabase");

before(openWaitlistDatabase);

test("[SPM-147 AC3] withdrawal sets WITHDRAWN and sends a confirmation that stays visible", async () => {
  const eventId = await createEvent({ capacity: 10 });
  await register(A, eventId);
  const result = await withdraw(A, eventId);

  assert.equal(result.registration.registration_status, "WITHDRAWN");
  assert.equal(result.registration.late_withdrawal, false);
  const place = await placeOf(A, eventId);
  assert.equal(place.registration_status, "WITHDRAWN");
  assert.ok(place.withdrawal_date);

  const notice = (await noticesFor(A, eventId)).at(-1);
  assert.equal(notice.type, "REGISTRATION_WITHDRAWN");
  assert.match(notice.message, /^You've withdrawn your registration for "Synthetic Gala" on .+ SGT\. To attend, register again; /);
  assert.equal(await visible(A, "ATTENDEE", eventId, "REGISTRATION_WITHDRAWN"), true);
  assert.equal(await visible(A, "ATTENDEE", eventId, "REGISTRATION_CONFIRMED"), false);
  await assert.rejects(withdraw(A, eventId), /NOT_REGISTERED/);
});

test("[SPM-147 AC4] a withdrawal with nobody waiting offers nothing", async () => {
  const eventId = await createEvent({ capacity: 1 });
  await register(A, eventId);
  await withdraw(A, eventId);
  assert.equal((await offersFor(eventId)).length, 0);
});

test("[SPM-147 AC5] withdrawal is refused once the event has started", async () => {
  const started = await createEvent({ startsIn: "-1 minute" });
  await register(A, started);
  await assert.rejects(withdraw(A, started), /EVENT_STARTED/);
  const completed = await createEvent({ startsIn: "-3 days", status: "COMPLETED" });
  await register(A, completed);
  await assert.rejects(withdraw(A, completed), /EVENT_STARTED/);
  assert.equal((await placeOf(A, started)).registration_status, "REGISTERED");
});

test("[SPM-147 AC6] the owner hears of withdrawals within 24 hours of the start, without the attendee's name", async () => {
  const lateNotices = async (startsIn) => {
    const eventId = await createEvent({ capacity: 10, startsIn });
    await register(A, eventId);
    await register(B, eventId);
    const result = await withdraw(A, eventId);
    return { result, notices: (await noticesFor(ORGANISER, eventId)).filter((notice) => notice.type === "REGISTRATION_ALERT") };
  };

  const dayBefore = await lateNotices("23 hours");
  assert.equal(dayBefore.result.registration.late_withdrawal, true);
  assert.equal(dayBefore.notices.length, 1);
  assert.equal(dayBefore.notices[0].title, "Late withdrawal");
  assert.match(dayBefore.notices[0].message, /^An attendee withdrew from "Synthetic Gala", which starts .+ SGT\. Registered now: 1 of 10\.$/);
  assert.doesNotMatch(dayBefore.notices[0].message, /Attendee A/);

  assert.equal((await lateNotices("2 hours")).notices.length, 1);
  assert.equal((await lateNotices("25 hours")).notices.length, 0);
  const venueOnly = await createEvent({ capacity: null, venueCapacity: 50, startsIn: "3 hours" });
  await register(A, venueOnly);
  await withdraw(A, venueOnly);
  const [venueNotice] = await noticesFor(ORGANISER, venueOnly);
  assert.match(venueNotice.message, /Registered now: 0 of 50.$/);

  const farFuture = await lateNotices("30 days");
  assert.equal(farFuture.result.registration.late_withdrawal, false);
  assert.equal(farFuture.notices.length, 0);
});

test("[SPM-147] withdrawal refuses waitlisted places, places it cannot see and cancelled events", async () => {
  const eventId = await fullEventWithQueue([B]);
  await assert.rejects(withdraw(B, eventId), /NOT_REGISTERED/);
  await assert.rejects(withdraw(C, eventId), /EVENT_NOT_FOUND/);
  await assert.rejects(withdraw(A, 999999), /EVENT_NOT_FOUND/);

  const cancelled = await createEvent({ status: "CANCELLED" });
  await register(A, cancelled);
  await assert.rejects(withdraw(A, cancelled), /EVENT_NOT_ACTIVE/);
});

test("[SPM-147] a replayed withdrawal returns the stored result without duplicate notices", async () => {
  const eventId = await createEvent({ capacity: 10, startsIn: "3 hours" });
  await register(A, eventId);
  const first = await withdraw(A, eventId, "spm147-withdraw-01");
  const replay = await withdraw(A, eventId, "spm147-withdraw-01");
  assert.equal(replay.replayed, true);
  assert.equal(replay.registration.withdrawal_date, first.registration.withdrawal_date);
  assert.equal((await noticesFor(A, eventId)).filter((notice) => notice.type === "REGISTRATION_WITHDRAWN").length, 1);
  assert.equal((await noticesFor(ORGANISER, eventId)).length, 1);
});

test("[SPM-147] withdrawing twice frees one place, makes one offer and writes each notice once", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  const { registration_id: registrationId } = await placeOf(A, eventId);
  await withdraw(A, eventId);
  await assert.rejects(withdraw(A, eventId), /NOT_REGISTERED/);

  assert.deepEqual((await offersFor(eventId)).map((offer) => [offer.attendee_id, offer.state]), [[B, "OPEN"]]);
  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  assert.equal((await noticesFor(A, eventId)).filter((notice) => notice.type === "REGISTRATION_WITHDRAWN").length, 1);
  assert.equal((await noticesFor(B, eventId)).filter((notice) => notice.type === "WAITLIST_OFFER").length, 1);
  assert.deepEqual((await noticesFor(C, eventId)).map((notice) => notice.type), ["WAITLIST_JOINED"]);
  const { n: withdrawals } = await one(
    "SELECT count(*)::int AS n FROM public.activity_log WHERE entity_id = $1 AND action = 'REGISTRATION_WITHDRAWN'",
    [registrationId]
  );
  assert.equal(withdrawals, 1);
});

// Regression for PR 39 Finding 2: withdrawal refused when event started after
// waiting for locks. clock_timestamp() is used after locks are acquired.
test("[SPM-147/PR39-F2] withdrawal refused when event started after lock wait", async () => {
  const eventId = await createEvent({ startsIn: "5 seconds" });
  await register(A, eventId);

  // Move event start to the past
  await one("UPDATE public.event SET start_datetime = clock_timestamp() - interval '1 second' WHERE event_id = $1", [eventId]);

  await assert.rejects(withdraw(A, eventId), /EVENT_STARTED/);
  assert.equal((await placeOf(A, eventId)).registration_status, "REGISTERED");
});

// Regression for PR 39 Finding 2: late withdrawal classification uses fresh
// post-lock time, not transaction-start time. 24-hour boundary is accurate.
test("[SPM-147/PR39-F2] late withdrawal classification uses post-lock time", async () => {
  const eventId = await createEvent({ startsIn: "25 hours" });
  await register(A, eventId);

  // Move event start to 23 hours from now (within late window)
  await one("UPDATE public.event SET start_datetime = clock_timestamp() + interval '23 hours' WHERE event_id = $1", [eventId]);

  const result = await withdraw(A, eventId);
  assert.equal(result.registration.late_withdrawal, true);
  assert.equal((await noticesFor(ORGANISER, eventId)).filter((notice) => notice.type === "REGISTRATION_ALERT").length, 1);
});
