// Attendee lifecycle rule (31 October 2026, supersedes SPM-44's CONFIRMED only):
// published CONFIRMED and PREPARATION events are attendee-facing under the same
// registration, waitlist and offer rules; other states stay hidden. Runs the
// real migrations on an isolated in-memory PostgreSQL engine.
// Run: node --test tests/database/attendeeLifecyclePreparation.test.cjs
const { before, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  openWaitlistDatabase,
  ORGANISER,
  A,
  B,
  C,
  one,
  rows,
  createEvent,
  register,
  registerDirect,
  availabilityOf,
  applyMigration,
  join,
  accept,
  decline,
  withdraw,
  placeOf,
  positionOf,
  offersFor,
  openOfferOf,
  fullEventWithQueue,
  query,
} = require("../fixtures/waitlistDatabase");

const MIGRATION = "20261031140000_attendee_lifecycle_preparation_publication.sql";
const HIDDEN_STATES = ["PLANNING", "SAFETY_REVIEW", "CANCELLED", "COMPLETED"];
const setStatus = (eventId, status) => query("UPDATE public.event SET status = $2 WHERE event_id = $1", [eventId, status]);

before(openWaitlistDatabase);

test("[ATTENDEE-LIFECYCLE] a preparation event with places is OPEN and takes a direct registration", async () => {
  const eventId = await createEvent({ status: "PREPARATION", capacity: 5 });
  assert.equal(await availabilityOf(eventId), "OPEN");
  assert.equal((await registerDirect(A, eventId)).registration.registration_status, "REGISTERED");
  await assert.rejects(join(B, eventId), /PLACES_AVAILABLE/);
});

test("[ATTENDEE-LIFECYCLE] a full preparation event is FULL_WAITLIST and takes waitlist joins", async () => {
  const eventId = await fullEventWithQueue([], { status: "PREPARATION" });
  assert.equal(await availabilityOf(eventId), "FULL_WAITLIST");
  await assert.rejects(registerDirect(B, eventId), /REGISTRATION_FULL/);
  const joined = await join(B, eventId);
  assert.equal(joined.registration.registration_status, "WAITLISTED");
  assert.equal(joined.registration.waitlist_position, 1);
  assert.equal((await positionOf(B, eventId)).waitlist_position, 1);
});

test("[ATTENDEE-LIFECYCLE] in preparation, a withdrawal offers the place to the first in the queue, who can accept it", async () => {
  const eventId = await fullEventWithQueue([B, C], { status: "PREPARATION" });
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);
  assert.ok(offer, "the first in the queue must receive an offer");
  assert.deepEqual((await offersFor(eventId)).map((row) => row.attendee_id), [B]);

  const accepted = await accept(B, eventId, offer.offer_id);
  assert.equal(accepted.registration.registration_status, "REGISTERED");
  assert.equal((await placeOf(B, eventId)).registration_status, "REGISTERED");
  assert.equal((await positionOf(C, eventId)).waitlist_position, 1);
});

test("[ATTENDEE-LIFECYCLE] in preparation, declining passes the offer to the next person", async () => {
  const eventId = await fullEventWithQueue([B, C], { status: "PREPARATION" });
  await withdraw(A, eventId);
  await decline(B, eventId, (await openOfferOf(B, eventId)).offer_id);
  assert.ok(await openOfferOf(C, eventId), "the next person must receive the offer");
});

test("[ATTENDEE-LIFECYCLE] an offer made while confirmed can still be accepted after preparation starts", async () => {
  const eventId = await fullEventWithQueue([B]);
  await withdraw(A, eventId);
  const offer = await openOfferOf(B, eventId);
  await setStatus(eventId, "PREPARATION");
  assert.equal((await accept(B, eventId, offer.offer_id)).registration.registration_status, "REGISTERED");
});

test("[ATTENDEE-LIFECYCLE] preparation follows confirmed for every timing and capacity state", async () => {
  for (const status of ["CONFIRMED", "PREPARATION"]) {
    assert.equal(await availabilityOf(await createEvent({ status, opensIn: "1 day" })), "NOT_YET_OPEN", status);
    assert.equal(await availabilityOf(await createEvent({ status, capacity: 5 })), "OPEN", status);
    assert.equal(await availabilityOf(await fullEventWithQueue([], { status })), "FULL_WAITLIST", status);
    assert.equal(await availabilityOf(await createEvent({ status, closesIn: "-1 minute" })), "CLOSED", status);
    assert.equal(await availabilityOf(await createEvent({ status, venueCapacity: null })), "UNAVAILABLE", status);
    const noDates = await createEvent({ status });
    await query("UPDATE public.event SET registration_open_at = NULL, registration_close_at = NULL WHERE event_id = $1", [noDates]);
    assert.equal(await availabilityOf(noDates), "UNAVAILABLE", status);
  }
});

test("[ATTENDEE-LIFECYCLE] planning, safety review, cancelled and completed events stay closed to attendees", async () => {
  for (const status of HIDDEN_STATES) {
    const open = await createEvent({ status, capacity: 5 });
    assert.equal(await availabilityOf(open), "CLOSED", status);
    await assert.rejects(registerDirect(A, open), /EVENT_NOT_FOUND/, status);

    const full = await fullEventWithQueue([], { status });
    await assert.rejects(join(B, full), /EVENT_NOT_FOUND/, status);
  }
});

test("[ATTENDEE-LIFECYCLE] an open offer cannot be accepted once the event leaves confirmed or preparation", async () => {
  for (const status of HIDDEN_STATES) {
    const eventId = await fullEventWithQueue([B]);
    await withdraw(A, eventId);
    const offer = await openOfferOf(B, eventId);
    await setStatus(eventId, status);
    await assert.rejects(accept(B, eventId, offer.offer_id), /REGISTRATION_CLOSED/, status);
    assert.equal((await placeOf(B, eventId)).registration_status, "WAITLISTED", status);
  }
});

test("[ATTENDEE-LIFECYCLE] an unpublished preparation event is hidden from registration and the waitlist", async () => {
  const eventId = await fullEventWithQueue([], { status: "PREPARATION" });
  await query("UPDATE public.event SET is_published = false WHERE event_id = $1", [eventId]);
  await assert.rejects(registerDirect(B, eventId), /EVENT_NOT_FOUND/);
  await assert.rejects(join(B, eventId), /EVENT_NOT_FOUND/);
});

test("[ATTENDEE-LIFECYCLE] the backfill publishes only confirmed or preparation events that were confirmed and have not ended", async () => {
  const insert = async (status, { published = false, confirmed = true, ended = false } = {}) =>
    (await one(
      `INSERT INTO public.event (organiser_id, title, status, is_published, previously_confirmed, start_datetime, end_datetime)
       VALUES ($1, 'Backfill case', $2, $3, $4,
               now() + CASE WHEN $5 THEN interval '-3 hours' ELSE interval '7 days' END,
               now() + CASE WHEN $5 THEN interval '-1 hour' ELSE interval '7 days 2 hours' END)
       RETURNING event_id`,
      [ORGANISER, status, published, confirmed, ended]
    )).event_id;

  const expectPublished = [await insert("CONFIRMED"), await insert("PREPARATION")];
  const expectUnchanged = {
    [await insert("CONFIRMED", { confirmed: false })]: false,
    [await insert("PREPARATION", { confirmed: false })]: false,
    [await insert("CONFIRMED", { ended: true })]: false,
    [await insert("PREPARATION", { ended: true })]: false,
    [await insert("PLANNING")]: false,
    [await insert("SAFETY_REVIEW")]: false,
    [await insert("CANCELLED")]: false,
    [await insert("COMPLETED")]: false,
    [await insert("DRAFT", { confirmed: false })]: false,
    [await insert("PLANNING", { published: true })]: true,
  };
  await applyMigration(MIGRATION);

  const published = await rows("SELECT event_id, is_published FROM public.event WHERE event_id = ANY($1)",
    [[...expectPublished, ...Object.keys(expectUnchanged).map(Number)]]);
  const byId = Object.fromEntries(published.map((row) => [row.event_id, row.is_published]));
  for (const eventId of expectPublished) assert.equal(byId[eventId], true, `event ${eventId} should be published`);
  for (const [eventId, flag] of Object.entries(expectUnchanged)) assert.equal(byId[eventId], flag, `event ${eventId} should be unchanged`);
});

test("[ATTENDEE-LIFECYCLE] the discovery index covers published confirmed and preparation events", async () => {
  const { def } = await one("SELECT pg_get_indexdef('public.event_attendee_discovery_idx'::regclass) AS def");
  assert.match(def, /\(start_datetime, event_id\)/);
  assert.match(def, /is_published/);
  assert.match(def, /'CONFIRMED'/);
  assert.match(def, /'PREPARATION'/);
});
