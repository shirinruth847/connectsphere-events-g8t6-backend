// SPM-163 / SPM-147 live integration tests: real Express routes, middleware,
// Supabase Auth and the shared development database from .env. Nothing is
// mocked. Fixtures are synthetic and namespaced by run ID; every event and
// registration is in the manifest, and waitlist offers go with their
// registration. Audit entries are removed through TEST_DATABASE_URL.
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { createRegistrationFixtures, bookPrimaryVenue } = require("../fixtures/registrationFixtures");
const { assertAuditCleanupAvailable } = require("../fixtures/adminCleanup");

jest.setTimeout(300000);

const runId = newRunId();
const DAY = 24 * 60 * 60 * 1000;
const RACE_ROUNDS = 6;
// Where each round's accept should reach the database, relative to the deadline.
const RACE_ARRIVALS_MS = [-600, -400, -250, -150, -50, 100];
// Registration on a race event closes this long after it is created, so the
// offer made on withdrawal expires then (D05: capped at registration close).
const RACE_CLOSE_MS = 12000;
// Rounds of each last-place race (two requests fired together).
const CONCURRENCY_ROUNDS = 3;

let fixtures;
let eventOffset = 0;
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      return session;
    }));
  }
  return sessions.get(key);
};
const bearer = async (key) => `Bearer ${(await signIn(key)).access_token}`;
const postAs = async (key, path, body) => {
  const req = request(app).post(path).set("Authorization", await bearer(key));
  return body === undefined ? req : req.send(body);
};
const getAs = async (key, path) => request(app).get(path).set("Authorization", await bearer(key));
const NO_ANSWERS = { dietaryRestrictions: null, accessibilityRequirements: null };

// One place (organiser cap 1) on its own primary venue and day.
const insertEvent = async ({ startsInMs, closesInMs, venue = true } = {}) => {
  eventOffset += 1;
  const startsAt = Date.now() + (startsInMs ?? (20 + eventOffset) * DAY);
  const { data, error } = await supabase.from("event").insert({
    title: `spm163-${runId}-event-${eventOffset}`,
    description: "Synthetic waitlist event",
    organiser_id: fixtures.accounts.organiserA.userId,
    organisation_id: fixtures.organisations.A,
    status: "CONFIRMED",
    start_datetime: new Date(startsAt).toISOString(),
    end_datetime: new Date(startsAt + 2 * 60 * 60 * 1000).toISOString(),
    expected_attendance: 1,
    preferred_layout_type: "THEATRE",
    is_published: true,
    is_registration_enabled: true,
    registration_capacity: 1,
    registration_open_at: new Date(Date.now() - DAY).toISOString(),
    registration_close_at: new Date(closesInMs === undefined ? startsAt - DAY : Date.now() + closesInMs).toISOString(),
  }).select("event_id,start_datetime,end_datetime").single();
  if (error) throw new Error(`Fixture event insert failed: ${error.message}`);
  recordFixtureIds(runId, "eventIds", [data.event_id]);
  if (venue) {
    await bookPrimaryVenue(runId, {
      eventId: data.event_id,
      requestedBy: fixtures.accounts.organiserA.userId,
      startDatetime: data.start_datetime,
      endDatetime: data.end_datetime,
      capacity: 50,
    });
  }
  return data.event_id;
};

const insertRegistered = async (eventId, accountKey) => {
  const { data, error } = await supabase.from("registration").insert({
    event_id: eventId,
    attendee_id: fixtures.accounts[accountKey].userId,
    registration_status: "REGISTERED",
  }).select("registration_id").single();
  if (error) throw new Error(`Fixture registration insert failed: ${error.message}`);
  recordFixtureIds(runId, "registrationIds", [data.registration_id]);
  return data.registration_id;
};

const joinAs = async (key, eventId) => {
  const res = await postAs(key, `/api/registrations/mine/${eventId}/waitlist`, NO_ANSWERS);
  if (res.status === 201) recordFixtureIds(runId, "registrationIds", [res.body.registration.registrationId]);
  return res;
};

// A full event: the holder has the one place and the waiter is first in the queue.
const fullEventWithWaiter = async (options) => {
  const eventId = await insertEvent(options);
  const holderRegistrationId = await insertRegistered(eventId, "holder");
  const joined = await joinAs("waiter", eventId);
  expect(joined.status).toBe(201);
  return { eventId, registrationId: joined.body.registration.registrationId, holderRegistrationId };
};

const statusOf = async (registrationId) => {
  const { data, error } = await supabase.from("registration").select("registration_status").eq("registration_id", registrationId).single();
  if (error) throw error;
  return data.registration_status;
};
const actionsOn = async (registrationId) => {
  const { data, error } = await supabase.from("activity_log").select("action").eq("entity_name", "registration").eq("entity_id", registrationId);
  if (error) throw error;
  return data.map((row) => row.action);
};
const expireDue = async () => {
  const { data, error } = await supabase.rpc("expire_due_waitlist_offers", { p_limit: 50 });
  if (error) throw new Error(error.message);
  return data;
};
const waitUntil = (time) => new Promise((resolve) => setTimeout(resolve, Math.max(0, time - Date.now())));

beforeAll(async () => {
  await assertAuditCleanupAvailable();
  fixtures = await createRegistrationFixtures(runId, [
    { key: "holder", role: "ATTENDEE" },
    { key: "waiter", role: "ATTENDEE" },
    { key: "walkIn", role: "ATTENDEE" },
    { key: "organiserA", role: "ORGANISER", organisation: "A" },
  ]);
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("[SPM-163] waitlist and place offers", () => {
  test("[SPM-163 AC1] joining is refused while the event has places", async () => {
    const eventId = await insertEvent();
    const res = await joinAs("waiter", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PLACES_AVAILABLE");
  });

  test("[SPM-163 AC1–AC3/AC5/AC6][SPM-147 AC3/AC4] join, see the position, get the freed place and accept it", async () => {
    const { eventId, registrationId } = await fullEventWithWaiter();

    const listed = (await getAs("waiter", "/api/registrations/mine")).body.registrations.find((row) => row.event.event_id === eventId);
    expect(listed).toMatchObject({ registration_status: "WAITLISTED", waitlistPosition: 1, offer: null });

    const withdrawn = await postAs("holder", `/api/registrations/mine/${eventId}/withdraw`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.registration).toMatchObject({ status: "WITHDRAWN", lateWithdrawal: false });

    const mine = await getAs("waiter", `/api/registrations/mine/${eventId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.myRegistration).toMatchObject({ status: "WAITLISTED", waitlistPosition: 1, offer: { offerId: expect.any(Number) } });
    const { offerId, expiresAt } = mine.body.myRegistration.offer;
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);

    const accepted = await postAs("waiter", `/api/registrations/mine/${eventId}/offer/accept`, { offerId });
    expect(accepted.status).toBe(200);
    expect(accepted.body.registration).toMatchObject({ registrationId, status: "REGISTERED", outcome: "ACCEPTED" });
    expect((await getAs("waiter", `/api/registrations/mine/${eventId}`)).body.myRegistration).toMatchObject({
      status: "REGISTERED",
      waitlistPosition: null,
      offer: null,
    });
  });

  test("[SPM-163 AC4] leaving the waitlist withdraws the place", async () => {
    const { eventId, registrationId } = await fullEventWithWaiter();
    const left = await postAs("waiter", `/api/registrations/mine/${eventId}/waitlist/leave`);
    expect(left.status).toBe(200);
    expect(left.body.registration).toMatchObject({ status: "WITHDRAWN", outcome: "LEFT", waitlistPosition: null });
    expect(await statusOf(registrationId)).toBe("WITHDRAWN");
  });

  test("[SPM-147 AC5] withdrawal is refused once the event has started", async () => {
    const eventId = await insertEvent({ startsInMs: -60 * 60 * 1000, closesInMs: -2 * 60 * 60 * 1000, venue: false });
    const registrationId = await insertRegistered(eventId, "holder");
    const res = await postAs("holder", `/api/registrations/mine/${eventId}/withdraw`);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Cannot withdraw registration for past events", code: "EVENT_STARTED" });
    expect(await statusOf(registrationId)).toBe("REGISTERED");
  });
});

// Two pooled connections at once: the attendee's accept through the API and
// the expiry job's function, fired around the offer's deadline. The event lock
// and the recheck must let exactly one of them win, whichever arrives first.
describe("[SPM-163 AC6/AC7] accept against expiry at the deadline", () => {
  test("[SPM-163 AC6/AC7] exactly one of accept and expiry wins, every round", async () => {
    const outcomes = [];
    for (let round = 0; round < RACE_ROUNDS; round += 1) {
      const { eventId, registrationId } = await fullEventWithWaiter({ closesInMs: RACE_CLOSE_MS });
      // The deadline is in database time. The withdrawal's database time
      // against this machine's clock converts it, and the withdrawal's round
      // trip estimates how long an authenticated request takes to reach the
      // database, so the accept can be aimed at the deadline.
      const sentAt = Date.now();
      const withdrawn = await postAs("holder", `/api/registrations/mine/${eventId}/withdraw`);
      const roundTrip = Date.now() - sentAt;
      expect(withdrawn.status).toBe(200);
      const toLocal = Date.now() - Date.parse(withdrawn.body.registration.withdrawnAt);
      const { offer } = (await getAs("waiter", `/api/registrations/mine/${eventId}`)).body.myRegistration;
      expect(offer).toEqual({ offerId: expect.any(Number), expiresAt: expect.any(String) });

      const deadline = Date.parse(offer.expiresAt) + toLocal;
      await waitUntil(deadline + RACE_ARRIVALS_MS[round] - roundTrip);
      const [accepted] = await Promise.all([
        postAs("waiter", `/api/registrations/mine/${eventId}/offer/accept`, { offerId: offer.offerId }),
        waitUntil(deadline - 100).then(expireDue),
        waitUntil(deadline + 50).then(expireDue),
      ]);
      await expireDue();

      const actions = await actionsOn(registrationId);
      const acceptedCount = actions.filter((action) => action === "WAITLIST_OFFER_ACCEPTED").length;
      const expiredCount = actions.filter((action) => action === "WAITLIST_OFFER_EXPIRED").length;
      const status = await statusOf(registrationId);
      if (accepted.status === 200) {
        expect({ status, acceptedCount, expiredCount }).toEqual({ status: "REGISTERED", acceptedCount: 1, expiredCount: 0 });
        outcomes.push("ACCEPTED");
      } else {
        expect(accepted.status).toBe(409);
        expect(accepted.body.code).toBe("OFFER_EXPIRED");
        expect({ status, acceptedCount, expiredCount }).toEqual({ status: "WITHDRAWN", acceptedCount: 0, expiredCount: 1 });
        outcomes.push("EXPIRED");
      }
    }
    console.info(`[SPM-163] race outcomes: ${outcomes.join(", ")}`);
  });
});

// An open offer holds its place against direct registration (20261031080611).
const registerAs = async (key, eventId) => {
  const res = await postAs(key, `/api/registrations/mine/${eventId}`, NO_ANSWERS);
  if (res.status === 201) recordFixtureIds(runId, "registrationIds", [res.body.registration.registrationId]);
  return res;
};
const availabilityOf = async (eventId) => {
  const { data, error } = await supabase.from("event").select("event_registration_availability").eq("event_id", eventId).single();
  if (error) throw error;
  return data.event_registration_availability;
};
const registeredCount = async (eventId) => {
  const { count, error } = await supabase
    .from("registration")
    .select("registration_id", { count: "exact", head: true })
    .eq("event_id", eventId)
    .eq("registration_status", "REGISTERED");
  if (error) throw error;
  return count;
};
const offerOf = async (key, eventId) => (await getAs(key, `/api/registrations/mine/${eventId}`)).body.myRegistration.offer;
const withdrawAs = (key, eventId) => postAs(key, `/api/registrations/mine/${eventId}/withdraw`);
const acceptAs = (key, eventId, offerId) => postAs(key, `/api/registrations/mine/${eventId}/offer/accept`, { offerId });
const sortedStatuses = (responses) => responses.map((res) => res.status).sort();

describe("[SPM-163] an open offer holds its place", () => {
  test("[SPM-163 AC5/AC6] discovery shows the event full and a direct registration is refused until the offer is answered", async () => {
    const { eventId, registrationId } = await fullEventWithWaiter();
    expect((await withdrawAs("holder", eventId)).status).toBe(200);
    const offer = await offerOf("waiter", eventId);
    expect(offer).toEqual({ offerId: expect.any(Number), expiresAt: expect.any(String) });

    expect(await availabilityOf(eventId)).toBe("FULL_WAITLIST");
    const direct = await registerAs("walkIn", eventId);
    expect(direct.status).toBe(409);
    expect(direct.body.code).toBe("REGISTRATION_FULL");

    const accepted = await acceptAs("waiter", eventId, offer.offerId);
    expect(accepted.status).toBe(200);
    expect(accepted.body.registration).toMatchObject({ registrationId, status: "REGISTERED", outcome: "ACCEPTED" });
    expect(await registeredCount(eventId)).toBe(1);
  });
});

// Two requests on two pooled connections at once, repeated. The event lock
// serialises them, so whichever reaches the database first, one place is
// allocated once and the queue keeps it.
describe("[SPM-163][SPM-147] last-place races", () => {
  test("[SPM-163 AC6] the offered attendee's accept against an unrelated direct registration", async () => {
    for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
      const { eventId } = await fullEventWithWaiter();
      expect((await withdrawAs("holder", eventId)).status).toBe(200);
      const { offerId } = await offerOf("waiter", eventId);

      const [accepted, direct] = await Promise.all([acceptAs("waiter", eventId, offerId), registerAs("walkIn", eventId)]);
      expect(accepted.status).toBe(200);
      expect(direct.status).toBe(409);
      expect(direct.body.code).toBe("REGISTRATION_FULL");
      expect(await registeredCount(eventId)).toBe(1);
    }
  });

  test("[SPM-147 AC4] a withdrawal against a direct registration: the freed place goes to the queue", async () => {
    for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
      const { eventId } = await fullEventWithWaiter();

      const [withdrawn, direct] = await Promise.all([withdrawAs("holder", eventId), registerAs("walkIn", eventId)]);
      expect(withdrawn.status).toBe(200);
      expect(direct.status).toBe(409);
      expect(direct.body.code).toBe("REGISTRATION_FULL");
      expect(await offerOf("waiter", eventId)).toEqual({ offerId: expect.any(Number), expiresAt: expect.any(String) });
      expect(await registeredCount(eventId)).toBe(0);
      expect(await availabilityOf(eventId)).toBe("FULL_WAITLIST");
    }
  });

  test("[SPM-163 AC6] two accepts of the same offer register the attendee once", async () => {
    for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
      const { eventId, registrationId } = await fullEventWithWaiter();
      expect((await withdrawAs("holder", eventId)).status).toBe(200);
      const { offerId } = await offerOf("waiter", eventId);

      const responses = await Promise.all([acceptAs("waiter", eventId, offerId), acceptAs("waiter", eventId, offerId)]);
      expect(sortedStatuses(responses)).toEqual([200, 409]);
      expect(responses.find((res) => res.status === 409).body.code).toBe("OFFER_NOT_OPEN");
      expect((await actionsOn(registrationId)).filter((action) => action === "WAITLIST_OFFER_ACCEPTED")).toHaveLength(1);
      expect(await registeredCount(eventId)).toBe(1);
    }
  });

  test("[SPM-147] two withdrawals at once free one place and make one offer", async () => {
    for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
      const { eventId, registrationId, holderRegistrationId } = await fullEventWithWaiter();

      const responses = await Promise.all([withdrawAs("holder", eventId), withdrawAs("holder", eventId)]);
      expect(sortedStatuses(responses)).toEqual([200, 409]);
      expect(responses.find((res) => res.status === 409).body.code).toBe("NOT_REGISTERED");
      expect((await actionsOn(holderRegistrationId)).filter((action) => action === "REGISTRATION_WITHDRAWN")).toHaveLength(1);
      expect((await actionsOn(registrationId)).filter((action) => action === "WAITLIST_OFFER_CREATED")).toHaveLength(1);
      expect(await availabilityOf(eventId)).toBe("FULL_WAITLIST");
    }
  });
});
