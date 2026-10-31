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
  E,
  INACTIVE,
  OTHER_HASH,
  one,
  createEvent,
  setVenueCapacity,
  register,
  registerDirect,
  availabilityOf,
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

test("[SPM-163 AC1] a full event takes waitlist joins; an event with places refuses them", async () => {
  const fullEvent = await fullEventWithQueue([]);
  const joined = await join(B, fullEvent);
  assert.equal(joined.registration.registration_status, "WAITLISTED");
  assert.equal(joined.registration.waitlist_position, 1);

  const openEvent = await createEvent({ capacity: 5 });
  await assert.rejects(join(B, openEvent), /PLACES_AVAILABLE/);
  const venueOnly = await createEvent({ capacity: null, venueCapacity: 5 });
  await assert.rejects(join(B, venueOnly), /PLACES_AVAILABLE/);
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
  // Allow for small timing variations (within 1 second)
  const diffMs = new Date(offers[0].expires_at) - new Date(offers[0].offered_at);
  assert.ok(Math.abs(diffMs - 24 * 60 * 60 * 1000) < 1000, `Offer window should be ~24 hours, got ${diffMs}ms`);
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

// ---------- SPM-134's place limit and availability (20261031030000) ----------

test("[SPM-163] the place limit is the primary venue's capacity, lowered by the organiser's cap", async () => {
  const venueOnly = await createEvent({ capacity: null, venueCapacity: 1 });
  await register(A, venueOnly);
  assert.equal((await join(B, venueOnly)).registration.registration_status, "WAITLISTED");
  await withdraw(A, venueOnly);
  assert.deepEqual((await offersFor(venueOnly)).map((offer) => [offer.attendee_id, offer.state]), [[B, "OPEN"]]);

  const smallerVenue = await createEvent({ capacity: 5, venueCapacity: 2 });
  await register(A, smallerVenue);
  await register(B, smallerVenue);
  assert.equal((await join(C, smallerVenue)).registration.waitlist_position, 1);
});

test("[SPM-163 AC1] exactly one of register and join works, with SPM-134's refusals", async () => {
  const open = await createEvent({ capacity: 2 });
  await assert.rejects(join(B, open), /PLACES_AVAILABLE/);
  assert.equal((await registerDirect(B, open)).registration.registration_status, "REGISTERED");

  const full = await fullEventWithQueue([]);
  assert.equal(await availabilityOf(full), "FULL_WAITLIST");
  await assert.rejects(registerDirect(B, full), /REGISTRATION_FULL/);
  assert.equal((await join(B, full)).registration.registration_status, "WAITLISTED");

  await assert.rejects(join(B, await createEvent({ opensIn: "1 day" })), /REGISTRATION_NOT_YET_OPEN/);
  await assert.rejects(join(B, await createEvent({ venueCapacity: null })), /REGISTRATION_UNAVAILABLE/);
});

test("[SPM-163 AC6] an offer cannot be accepted once the venue limit drops below it or the venue is gone", async () => {
  const eventId = await createEvent({ capacity: null, venueCapacity: 2 });
  await register(A, eventId);
  await register(D, eventId);
  await join(B, eventId);
  await withdraw(D, eventId);
  const offer = await openOfferOf(B, eventId);

  await setVenueCapacity(eventId, 1);
  await assert.rejects(accept(B, eventId, offer.offer_id), /REGISTRATION_FULL/);
  await query("DELETE FROM public.venue_booking WHERE event_id = $1", [eventId]);
  await assert.rejects(accept(B, eventId, offer.offer_id), /REGISTRATION_UNAVAILABLE/);
  assert.equal((await openOfferOf(B, eventId)).offer_id, offer.offer_id);
});

test("[SPM-163 AC5] no place is offered while the event has no primary venue", async () => {
  const eventId = await fullEventWithQueue([B]);
  await query("DELETE FROM public.venue_booking WHERE event_id = $1", [eventId]);
  await withdraw(A, eventId);
  assert.deepEqual(await offersFor(eventId), []);
  assert.equal((await placeOf(B, eventId)).registration_status, "WAITLISTED");
});

// ---------- open offers hold their places (20261031080611) ----------

const registeredCount = async (eventId) =>
  (await one("SELECT count(*)::int AS n FROM public.registration WHERE event_id = $1 AND registration_status = 'REGISTERED'", [eventId])).n;
const setOrganiserCap = (eventId, capacity) =>
  query("UPDATE public.event SET registration_capacity = $2 WHERE event_id = $1", [eventId, capacity]);

test("[SPM-163 AC5/AC6] an open offer holds the place: direct registration is refused and the offer can still be accepted", async () => {
  const eventId = await fullEventWithQueue([B]);
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);

  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  await assert.rejects(registerDirect(C, eventId), /REGISTRATION_FULL/);
  assert.equal(await placeOf(C, eventId), undefined);
  assert.equal((await accept(B, eventId, offer.offer_id)).registration.registration_status, "REGISTERED");
  assert.equal(await registeredCount(eventId), 1);
});

test("[SPM-163] an open offer takes one place under the venue and organiser limit", async () => {
  const eventId = await createEvent({ capacity: 3, venueCapacity: 4 });
  for (const attendeeId of [A, D, E]) await register(attendeeId, eventId);
  await join(B, eventId);
  await withdraw(E, eventId);
  assert.ok(await openOfferOf(B, eventId));

  // Two registered and one open offer fill the organiser's 3 of the venue's 4.
  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  await assert.rejects(registerDirect(C, eventId), /REGISTRATION_FULL/);
  await setOrganiserCap(eventId, 10);
  assert.equal(await availabilityOf(eventId), "OPEN");
  assert.equal((await registerDirect(C, eventId)).registration.registration_status, "REGISTERED");
  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  assert.equal(await registeredCount(eventId), 3);
});

test("[SPM-163 AC7] after a decline the next person's offer holds the place", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await withdraw(A, eventId);
  await decline(B, eventId, (await openOfferOf(B, eventId)).offer_id);

  assert.equal((await placeOf(B, eventId)).registration_status, "WITHDRAWN");
  const next = await openOfferOf(C, eventId);
  assert.ok(next);
  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  await assert.rejects(registerDirect(D, eventId), /REGISTRATION_FULL/);
  assert.equal((await accept(C, eventId, next.offer_id)).registration.registration_status, "REGISTERED");
  assert.equal(await registeredCount(eventId), 1);
});

test("[SPM-163 AC7] an overdue offer holds nothing, yet its place goes to the next in the queue before any direct registrant", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await withdraw(A, eventId);
  const overdue = await openOfferOf(B, eventId);
  await makeOverdue(overdue.offer_id);

  // Before the job runs, C is owed the place and B can no longer take it.
  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  await assert.rejects(registerDirect(D, eventId), /REGISTRATION_FULL/);
  await assert.rejects(accept(B, eventId, overdue.offer_id), /OFFER_EXPIRED/);

  await expireDue();
  assert.equal((await placeOf(B, eventId)).registration_status, "WITHDRAWN");
  const next = await openOfferOf(C, eventId);
  assert.ok(next);
  await assert.rejects(registerDirect(D, eventId), /REGISTRATION_FULL/);
  await assert.rejects(accept(B, eventId, overdue.offer_id), /OFFER_EXPIRED/);
  assert.equal(await placeOf(D, eventId), undefined);
  assert.equal((await accept(C, eventId, next.offer_id)).registration.registration_status, "REGISTERED");
  assert.equal(await registeredCount(eventId), 1);
});

test("[SPM-163 AC7] with nobody else queued, an overdue offer's place opens to a direct registration, which expires the offer", async () => {
  const eventId = await fullEventWithQueue([B]);
  await withdraw(A, eventId);
  const overdue = await openOfferOf(B, eventId);
  await makeOverdue(overdue.offer_id);

  assert.equal(await availabilityOf(eventId), "OPEN");
  assert.equal((await registerDirect(C, eventId)).registration.registration_status, "REGISTERED");
  assert.equal((await placeOf(B, eventId)).registration_status, "WITHDRAWN");
  assert.deepEqual((await offersFor(eventId)).map((offer) => offer.state), ["EXPIRED"]);
  assert.equal(await registeredCount(eventId), 1);
});

test("[SPM-163] a direct registration offers freed places to the queue first and takes only what is left", async () => {
  const eventId = await fullEventWithQueue([B, C]);
  await setOrganiserCap(eventId, 4);

  // Three free places, two of them owed to B and C: one is open.
  assert.equal(await availabilityOf(eventId), "OPEN");
  assert.equal((await registerDirect(D, eventId)).registration.registration_status, "REGISTERED");
  assert.ok(await openOfferOf(B, eventId));
  assert.ok(await openOfferOf(C, eventId));
  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  await assert.rejects(registerDirect(E, eventId), /REGISTRATION_FULL/);
});

test("[SPM-163] a place freed for the queue is refused to a direct registrant and offered by the job", async () => {
  const eventId = await fullEventWithQueue([B]);
  await setOrganiserCap(eventId, 2);

  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  await assert.rejects(registerDirect(C, eventId), /REGISTRATION_FULL/);
  // The refusal rolled back the offer it made; the job makes it instead.
  assert.equal(await openOfferOf(B, eventId), undefined);
  await expireDue();
  assert.ok(await openOfferOf(B, eventId));
  assert.equal(await placeOf(C, eventId), undefined);
  assert.equal(await expireDue(), 0);
  assert.equal((await offersFor(eventId)).length, 1);
});

test("[SPM-163 AC5] no offer is made while SPM-134 has the event unavailable for a missing registration start or end time", async () => {
  for (const column of ["registration_close_at", "registration_open_at"]) {
    const eventId = await fullEventWithQueue([B]);
    await query(`UPDATE public.event SET ${column} = NULL WHERE event_id = $1`, [eventId]);
    assert.equal(await availabilityOf(eventId), "UNAVAILABLE");

    await withdraw(A, eventId);
    await expireDue();
    assert.deepEqual(await offersFor(eventId), [], column);
    assert.equal((await placeOf(B, eventId)).registration_status, "WAITLISTED", column);
    assert.equal(await availabilityOf(eventId), "UNAVAILABLE", column);
  }
});

// Offers end by the event start (D05), so once it has started the queue can
// no longer be offered a place and does not hold one.
test("[SPM-163] after the event starts, a free place is open to direct registration while registration stays open", async () => {
  const eventId = await createEvent({ startsIn: "-30 minutes", closesIn: "1 hour" });
  await register(A, eventId);
  await join(B, eventId);
  await setOrganiserCap(eventId, 2);

  assert.equal(await availabilityOf(eventId), "OPEN");
  // Direct registration still works after event starts while registration window is open
  assert.equal((await registerDirect(C, eventId)).registration.registration_status, "REGISTERED");
});

// Regression for PR 39 Finding 1: offer acceptance uses clock_timestamp() after locks.
// This verifies the function has the v_now variable and uses it for expiry checks.
test("[SPM-163/PR39-F1] offer acceptance function uses post-lock clock_timestamp", async () => {
  const { prosrc } = await one("SELECT prosrc FROM pg_proc WHERE proname = 'accept_waitlist_offer' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')");
  assert.ok(prosrc.includes("v_now := clock_timestamp()"), "accept_waitlist_offer must use clock_timestamp() after locks");
  assert.ok(prosrc.includes("v_offer.expires_at <= v_now"), "accept_waitlist_offer must check expiry against v_now");
});

// Regression for PR 39 Finding 1: offer acceptance refuses when registration
// window closed after waiting for locks. clock_timestamp() is used after locks.
test("[SPM-163/PR39-F1] offer acceptance refused when registration window closed after lock wait", async () => {
  const eventId = await fullEventWithQueue([B]);
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);

  // Close registration window
  await query("UPDATE public.event SET registration_close_at = clock_timestamp() - interval '1 second' WHERE event_id = $1", [eventId]);

  await assert.rejects(accept(B, eventId, offer.offer_id), /REGISTRATION_CLOSED/);
  assert.equal((await placeOf(B, eventId)).registration_status, "WAITLISTED");
  assert.equal(await registeredCount(eventId), 0);
});
