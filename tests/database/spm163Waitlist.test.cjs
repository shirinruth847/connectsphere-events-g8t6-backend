// SPM-163 Join Event Waitlist on an isolated in-memory PostgreSQL engine.
// Run: node --test tests/database/spm163Waitlist.test.cjs
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  openWaitlistDatabase,
  ORGANISER,
  A,
  B,
  C,
  D,
  INACTIVE,
  OTHER_HASH,
  one,
  createEvent,
  register,
  join,
  leave,
  accept,
  decline,
  withdraw,
  expireDue,
  placeOf,
  positionOf,
  offersFor,
  openOfferOf,
  makeOverdue,
  noticesFor,
  visible,
  fullEventWithQueue,
  query,
} = require("../fixtures/waitlistDatabase");

before(openWaitlistDatabase);

test("[SPM-163 AC1] a full event takes waitlist joins; an event with places or no limit refuses them", async () => {
  const fullEvent = await fullEventWithQueue([]);
  const joined = await join(B, fullEvent);
  assert.equal(joined.registration.registration_status, "WAITLISTED");
  assert.equal(joined.registration.waitlist_position, 1);

  const openEvent = await createEvent({ capacity: 5 });
  await assert.rejects(join(B, openEvent), /PLACES_AVAILABLE/);
  const unlimitedEvent = await createEvent({ capacity: null });
  await assert.rejects(join(B, unlimitedEvent), /PLACES_AVAILABLE/);
});

test("[SPM-163 AC1] joining refuses duplicates, closed registration, hidden events and non-attendees", async () => {
  const eventId = await fullEventWithQueue([B]);
  await assert.rejects(join(A, eventId), /ALREADY_REGISTERED/);
  await assert.rejects(join(B, eventId), /ALREADY_WAITLISTED/);
  await assert.rejects(join(ORGANISER, eventId), /NOT_ATTENDEE/);

  const closed = await fullEventWithQueue([], { closesIn: "-1 minute" });
  await assert.rejects(join(B, closed), /REGISTRATION_CLOSED/);
  const replanning = await createEvent({ status: "PLANNING" });
  await assert.rejects(join(B, replanning), /EVENT_NOT_FOUND/);
});

test("[SPM-163 AC2] joining sends the waitlist notice with the position", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  const [notice] = await noticesFor(C, eventId);
  assert.equal(notice.type, "WAITLIST_JOINED");
  assert.equal(notice.title, "Waitlisted");
  assert.equal(notice.message, 'You are on the waitlist for "Synthetic Gala". Position: 2. You\'ll be notified if a spot opens.');
});

test("[SPM-163 AC3] positions are FIFO, stable, and move up when someone ahead leaves", async () => {
  const eventId = await fullEventWithQueue([B, C, D]);
  assert.deepEqual(
    [await positionOf(B, eventId), await positionOf(C, eventId), await positionOf(D, eventId)].map((row) => row.waitlist_position),
    [1, 2, 3]
  );
  await leave(B, eventId);
  assert.equal((await positionOf(C, eventId)).waitlist_position, 1);
  assert.equal((await positionOf(D, eventId)).waitlist_position, 2);
  assert.equal(await positionOf(B, eventId), undefined);
});

test("[SPM-163 AC3/D05] re-joining after leaving takes the back of the queue", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await leave(B, eventId);
  const rejoined = await join(B, eventId);
  assert.equal(rejoined.registration.waitlist_position, 2);
  assert.equal((await positionOf(C, eventId)).waitlist_position, 1);
});

test("[SPM-163 AC4] leaving withdraws the place, tells the attendee and stays in their inbox", async () => {
  const eventId = await fullEventWithQueue([B]);
  const left = await leave(B, eventId);
  assert.equal(left.registration.outcome, "LEFT");
  const place = await placeOf(B, eventId);
  assert.equal(place.registration_status, "WITHDRAWN");
  assert.equal(place.queue_order, null);

  const notices = await noticesFor(B, eventId);
  const leftNotice = notices.at(-1);
  assert.equal(leftNotice.type, "WAITLIST_LEFT");
  assert.match(leftNotice.message, /You left the waitlist for "Synthetic Gala"\. To attend, register again; .*back of the waitlist\./);
  assert.equal(await visible(B, "ATTENDEE", eventId, "WAITLIST_LEFT"), true);
  assert.equal(await visible(B, "ATTENDEE", eventId, "WAITLIST_JOINED"), false);
  await assert.rejects(leave(B, eventId), /NOT_WAITLISTED/);
  await assert.rejects(leave(C, eventId), /EVENT_NOT_FOUND/);
});

test("[SPM-163 AC5][SPM-147 AC4] a withdrawal offers the place to the first in the queue for 24 hours", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await withdraw(A, eventId);

  const offers = await offersFor(eventId);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].attendee_id, B);
  assert.equal(offers[0].state, "OPEN");
  assert.equal(new Date(offers[0].expires_at) - new Date(offers[0].offered_at), 24 * 60 * 60 * 1000);
  assert.equal((await placeOf(B, eventId)).registration_status, "WAITLISTED");
  assert.equal((await positionOf(B, eventId)).offer_id, offers[0].offer_id);

  const notice = (await noticesFor(B, eventId)).at(-1);
  assert.equal(notice.type, "WAITLIST_OFFER");
  assert.match(notice.message, /^A spot has opened in "Synthetic Gala"! You have 24 hours to accept or decline \(until .+ SGT\)\.$/);
  assert.equal(await openOfferOf(C, eventId), undefined);
});

test("[SPM-163 AC5/D05] the offer window is capped at registration close and event start", async () => {
  const closesSoon = await fullEventWithQueue([B], { closesIn: "3 hours" });
  await withdraw(A, closesSoon);
  const [byClose] = await offersFor(closesSoon);
  const event = await one("SELECT * FROM public.event WHERE event_id = $1", [closesSoon]);
  assert.equal(new Date(byClose.expires_at).getTime(), new Date(event.registration_close_at).getTime());
  assert.match((await noticesFor(B, closesSoon)).at(-1).message, /^A spot has opened in "Synthetic Gala"! You have until .+ SGT to accept or decline\.$/);

  const startsSoon = await fullEventWithQueue([B], { startsIn: "5 hours" });
  await withdraw(A, startsSoon);
  const [byStart] = await offersFor(startsSoon);
  const soonEvent = await one("SELECT * FROM public.event WHERE event_id = $1", [startsSoon]);
  assert.equal(new Date(byStart.expires_at).getTime(), new Date(soonEvent.start_datetime).getTime());
});

test("[SPM-163 AC5] no offer is made while the event is paused, and inactive attendees are skipped", async () => {
  const paused = await fullEventWithQueue([B]);
  await query("UPDATE public.event SET status = 'PLANNING' WHERE event_id = $1", [paused]);
  await withdraw(A, paused);
  assert.equal((await offersFor(paused)).length, 0);

  const skipping = await fullEventWithQueue([INACTIVE, C]);
  await query(`UPDATE public."user" SET is_active = false WHERE user_id = $1`, [INACTIVE]);
  await withdraw(A, skipping);
  const offers = await offersFor(skipping);
  await query(`UPDATE public."user" SET is_active = true WHERE user_id = $1`, [INACTIVE]);
  assert.deepEqual(offers.map((offer) => offer.attendee_id), [C]);
});

test("[SPM-163 AC6] accepting moves the attendee to Registered and confirms it", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);
  const accepted = await accept(B, eventId, offer.offer_id);

  assert.equal(accepted.registration.registration_status, "REGISTERED");
  assert.equal(accepted.registration.outcome, "ACCEPTED");
  assert.equal((await placeOf(B, eventId)).queue_order, null);
  assert.equal((await offersFor(eventId))[0].state, "ACCEPTED");
  const notice = (await noticesFor(B, eventId)).at(-1);
  assert.equal(notice.type, "REGISTRATION_CONFIRMED");
  assert.match(notice.message, /^You're registered for "Synthetic Gala" on /);
  assert.equal((await positionOf(C, eventId)).waitlist_position, 1);

  await assert.rejects(accept(B, eventId, offer.offer_id), /OFFER_NOT_OPEN/);
  await assert.rejects(accept(C, eventId, offer.offer_id), /OFFER_NOT_FOUND/);
});

test("[SPM-163 AC6] accepting refuses when capacity was reduced below the offered place", async () => {
  const eventId = await fullEventWithQueue([B]);
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);
  await register(C, eventId);
  await assert.rejects(accept(B, eventId, offer.offer_id), /REGISTRATION_FULL/);
  assert.equal((await openOfferOf(B, eventId)).offer_id, offer.offer_id);
});

test("[SPM-163 AC7] declining withdraws the place and offers it to the next person", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);
  const declined = await decline(B, eventId, offer.offer_id);

  assert.equal(declined.registration.outcome, "DECLINED");
  assert.equal((await placeOf(B, eventId)).registration_status, "WITHDRAWN");
  assert.equal((await offersFor(eventId))[0].state, "DECLINED");
  assert.ok(await openOfferOf(C, eventId));
  const notice = (await noticesFor(B, eventId)).at(-1);
  assert.equal(notice.type, "WAITLIST_LEFT");
  assert.match(notice.message, /^You declined the place at "Synthetic Gala" and left the waitlist\. To attend, register again; /);
});

test("[SPM-163 AC4/AC7] leaving with an open offer counts as declining it", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await withdraw(A, eventId);
  const left = await leave(B, eventId);
  assert.equal(left.registration.outcome, "DECLINED");
  assert.equal((await offersFor(eventId))[0].state, "DECLINED");
  assert.ok(await openOfferOf(C, eventId));
});

test("[SPM-163 AC7] an unanswered offer expires after its window and cascades to the next person", async () => {
  const eventId = await fullEventWithQueue([B, C, D]);
  await withdraw(A, eventId);
  const first = await openOfferOf(B, eventId);
  await makeOverdue(first.offer_id);
  assert.ok(await expireDue() >= 1);

  assert.equal((await placeOf(B, eventId)).registration_status, "WITHDRAWN");
  assert.equal((await offersFor(eventId))[0].state, "EXPIRED");
  const second = await openOfferOf(C, eventId);
  assert.ok(second);
  assert.match((await noticesFor(B, eventId)).at(-1).message, /^Your offer of a place at "Synthetic Gala" expired, so you've left the waitlist\./);

  // The cascade continues while nobody answers.
  await makeOverdue(second.offer_id);
  await expireDue();
  assert.ok(await openOfferOf(D, eventId));
  const expiry = await one(
    "SELECT * FROM public.activity_log WHERE entity_id = $1 AND action = 'WAITLIST_OFFER_EXPIRED'",
    [first.registration_id]
  );
  assert.equal(expiry.user_id, null);
  assert.equal(expiry.actor_role, "SYSTEM");
});

test("[SPM-163 AC6/AC7] an overdue offer cannot be accepted even before the job runs", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);
  await makeOverdue(offer.offer_id);

  await assert.rejects(accept(B, eventId, offer.offer_id), /OFFER_EXPIRED/);
  await assert.rejects(decline(B, eventId, offer.offer_id), /OFFER_EXPIRED/);
  assert.equal(await positionOf(B, eventId).then((row) => row.offer_id), null);
  assert.equal((await placeOf(B, eventId)).registration_status, "WAITLISTED");
  await expireDue();
  await assert.rejects(accept(B, eventId, offer.offer_id), /OFFER_EXPIRED/);
});

test("[SPM-163 AC7] the expiry job is safe to run twice, and accept and expiry never both win", async () => {
  const expiredFirst = await fullEventWithQueue([B]);
  await withdraw(A, expiredFirst);
  const lateOffer = await openOfferOf(B, expiredFirst);
  await makeOverdue(lateOffer.offer_id);
  await expireDue();
  const after = await offersFor(expiredFirst);
  assert.equal(await expireDue(), 0);
  assert.deepEqual(await offersFor(expiredFirst), after);
  await assert.rejects(accept(B, expiredFirst, lateOffer.offer_id), /OFFER_EXPIRED/);

  const acceptedFirst = await fullEventWithQueue([B]);
  await withdraw(A, acceptedFirst);
  const offer = await openOfferOf(B, acceptedFirst);
  await accept(B, acceptedFirst, offer.offer_id);
  await query("UPDATE public.waitlist_offer SET expires_at = now() - interval '1 second', offered_at = now() - interval '1 day' WHERE offer_id = $1", [offer.offer_id]);
  await expireDue();
  assert.equal((await offersFor(acceptedFirst))[0].state, "ACCEPTED");
  assert.equal((await placeOf(B, acceptedFirst)).registration_status, "REGISTERED");
});

test("[SPM-163] a replayed join returns the stored result without a second notice; a reused key is refused", async () => {
  const eventId = await fullEventWithQueue([]);
  const first = await join(B, eventId, "spm163-join-0001");
  const replay = await join(B, eventId, "spm163-join-0001");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.registration.registration_id, first.registration.registration_id);
  assert.equal((await noticesFor(B, eventId)).length, 1);
  await assert.rejects(join(B, eventId, "spm163-join-0001", OTHER_HASH), /IDEMPOTENCY_KEY_REUSED/);
});

test("[SPM-163] the database keeps one open offer per place and queue order only on waitlisted places", async () => {
  const eventId = await fullEventWithQueue([B]);
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);
  await assert.rejects(
    query("INSERT INTO public.waitlist_offer (registration_id, expires_at) VALUES ($1, now() + interval '1 hour')", [offer.registration_id]),
    /waitlist_offer_one_open_idx/
  );
  await query("UPDATE public.registration SET queue_order = 999999 WHERE registration_id = $1", [offer.registration_id]);
  assert.notEqual(Number((await placeOf(B, eventId)).queue_order), 999999);
});
