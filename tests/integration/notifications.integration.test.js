// SPM-155/156/158 against real Supabase Auth, PostgREST and the notification
// functions. Needs migrations 20261020161808 to 20261020161924 and
// TEST_DATABASE_URL (the private notify helpers run only as the database
// owner, exactly as a future workflow function would call them).
//
// Fixtures are spm32-<run> accounts, events and registrations, removed after
// the run with their notifications. Reminder cases run inside transactions
// that are rolled back, so they never send reminders for anyone else's data.
const request = require("supertest");
const { Client } = require("pg");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, createAuthFixtures, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { withCleanupConnection } = require("../fixtures/adminCleanup");

jest.setTimeout(180000);

const runId = newRunId();
let fixtures;
const sessions = new Map();

const signIn = async (key) => {
  if (!sessions.has(key)) {
    const account = fixtures.accounts[key];
    sessions.set(key, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) throw new Error(`Sign-in for ${key} failed.`);
      return session;
    }));
  }
  return sessions.get(key);
};

const call = async (method, path, key) => {
  const session = await signIn(key);
  return request(app)[method](path).set("Authorization", `Bearer ${session.access_token}`);
};

const userId = (key) => fixtures.accounts[key].userId;
const asOwner = (sql, values = []) => withCleanupConnection(async (client) => (await client.query(sql, values)).rows);

const registrationId = async (attendeeKey, eventKey) => {
  const { data, error } = await supabase
    .from("registration")
    .select("registration_id")
    .eq("attendee_id", userId(attendeeKey))
    .eq("event_id", fixtures.events[eventKey])
    .single();
  if (error) throw error;
  return data.registration_id;
};

const createEvent = async (title, { startsInHours = 24 * 30, status = "CONFIRMED" } = {}) => {
  const start = new Date(Date.now() + startsInHours * 3600 * 1000);
  const { data, error } = await supabase.from("event").insert({
    title: `spm32-${runId} ${title}`,
    description: `Public description for ${title}`,
    purpose: `Internal planning purpose for ${title}`,
    organiser_id: userId("organiserB"),
    status,
    start_datetime: start.toISOString(),
    end_datetime: new Date(start.getTime() + 2 * 3600 * 1000).toISOString(),
    is_published: true,
  }).select("event_id").single();
  if (error) throw error;
  recordFixtureIds(runId, "eventIds", [data.event_id]);
  return data.event_id;
};

const createRegistration = async (attendeeKey, eventId, status = "REGISTERED", registeredDaysAgo = 3) => {
  const { data, error } = await supabase.from("registration").insert({
    attendee_id: userId(attendeeKey),
    event_id: eventId,
    registration_status: status,
    registration_datetime: new Date(Date.now() - registeredDaysAgo * 86400 * 1000).toISOString(),
  }).select("registration_id").single();
  if (error) throw error;
  recordFixtureIds(runId, "registrationIds", [data.registration_id]);
  return data.registration_id;
};

const inboxFor = async (key) => {
  const res = await call("get", "/api/notifications?limit=100", key);
  expect(res.status).toBe(200);
  return res.body;
};

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for the notification integration tests.");
  fixtures = await createAuthFixtures(runId, { extraAccounts: [{ key: "attendeeTwo", role: "ATTENDEE" }] });
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

test("[SPM-155-TC-01/TC-02] registration and waitlist notices reach the attendee's inbox with a My Events target", async () => {
  await asOwner("SELECT public._notify_registration_recorded($1)", [await registrationId("attendee", "registeredConfirmed")]);
  await asOwner("SELECT public._notify_registration_recorded($1)", [await registrationId("attendee", "registeredPlanning")]);

  const { notifications, unreadCount } = await inboxFor("attendee");
  const confirmed = notifications.find((n) => n.event && n.event.event_id === fixtures.events.registeredConfirmed);
  const waitlisted = notifications.find((n) => n.event && n.event.event_id === fixtures.events.registeredPlanning);
  expect(confirmed).toMatchObject({
    type: "REGISTRATION_CONFIRMED",
    title: "Registration confirmed",
    is_read: false,
    read_at: null,
    event: { event_id: fixtures.events.registeredConfirmed, title: `spm32-${runId} registeredConfirmed` },
    target: { page: "MY_EVENTS", event_id: fixtures.events.registeredConfirmed },
  });
  expect(confirmed.message).toMatch(/^You're registered for ".+" on \w{3} \d{1,2} \w{3} 2027, \d{1,2}:\d{2} [AP]M SGT\.$/);
  expect(waitlisted).toMatchObject({ type: "WAITLIST_JOINED", title: "Waitlisted" });
  expect(unreadCount).toBe(2);
  // The reader's copy only: no recipients list or other people's IDs.
  expect(Object.keys(confirmed).sort()).toEqual(
    ["action_expires_at", "created_at", "event", "is_read", "message", "notification_id", "read_at", "target", "title", "type"]
  );
});

test("[SPM-155-TC-07/AC6] a notification about an event the attendee holds no place on is neither listed nor markable", async () => {
  const othersEvent = await createEvent("Others Only");
  await createRegistration("attendeeTwo", othersEvent);
  const [{ id }] = await asOwner(
    "SELECT public._notify_event_users($1, 'Other attendees', 'For registered attendees', $2::integer[], 'STATUS_CHANGE', NULL, NULL) AS id",
    [othersEvent, [userId("attendeeTwo"), userId("attendee")]]
  );

  const mine = await inboxFor("attendee");
  expect(mine.notifications.some((n) => n.notification_id === id)).toBe(false);
  expect(mine.unreadCount).toBe(2);
  const theirs = await inboxFor("attendeeTwo");
  expect(theirs.notifications.some((n) => n.notification_id === id)).toBe(true);

  const res = await call("post", `/api/notifications/${id}/read`, "attendee");
  expect(res.status).toBe(404);
  expect(res.body.code).toBe("NOTIFICATION_NOT_FOUND");
});

test("[SPM-155-TC-03/TC-04/TC-06] cancellation, offer and change notices show for registered and waitlisted attendees", async () => {
  const eventId = await createEvent("Busy Forum");
  await createRegistration("attendee", eventId);
  const waitlisted = await createRegistration("attendeeTwo", eventId, "WAITLISTED");
  const expiresAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  // No offers table exists yet (SPM-163); the registration ID stands in for the offer ID.
  await asOwner("SELECT public._notify_place_offered($1, $2, $3::timestamptz)", [waitlisted, waitlisted, expiresAt]);
  await asOwner(
    "SELECT public._notify_event_changed_attendees($1, $2::jsonb, $3::jsonb)",
    [eventId, JSON.stringify({ start_datetime: "2027-01-01T01:00:00Z" }), JSON.stringify({ start_datetime: "2027-01-02T01:00:00Z" })]
  );
  await asOwner("SELECT public._notify_event_cancelled_attendees($1)", [eventId]);
  await supabase.from("event").update({ status: "CANCELLED" }).eq("event_id", eventId);

  const types = (body) => body.notifications.filter((n) => n.event && n.event.event_id === eventId).map((n) => n.type).sort();
  expect(types(await inboxFor("attendee"))).toEqual(["EVENT_CANCELLED", "EVENT_CHANGED"]);
  const two = await inboxFor("attendeeTwo");
  expect(types(two)).toEqual(["EVENT_CANCELLED", "EVENT_CHANGED", "WAITLIST_OFFER"]);
  const offer = two.notifications.find((n) => n.type === "WAITLIST_OFFER");
  expect(offer.title).toBe("Action required: a place is available");
  expect(new Date(offer.action_expires_at).toISOString()).toBe(expiresAt);
  expect(offer.target).toEqual({ page: "MY_EVENTS", event_id: eventId });
});

test("[SPM-155-AC8] the inbox pages newest first through the API", async () => {
  const all = (await inboxFor("attendeeTwo")).notifications.map((n) => n.notification_id);
  const seen = [];
  let cursor = null;
  do {
    const res = await call("get", `/api/notifications?limit=1${cursor ? `&cursor=${cursor}` : ""}`, "attendeeTwo");
    expect(res.status).toBe(200);
    seen.push(...res.body.notifications.map((n) => n.notification_id));
    cursor = res.body.nextCursor;
  } while (cursor);
  expect(seen).toEqual(all);
  expect(all.length).toBeGreaterThanOrEqual(3);
});

test("[SPM-155-TC-08] marking one and then all as read updates the unread count", async () => {
  const before = await inboxFor("attendeeTwo");
  expect(before.unreadCount).toBeGreaterThanOrEqual(2);
  const target = before.notifications.find((n) => !n.is_read);

  const one = await call("post", `/api/notifications/${target.notification_id}/read`, "attendeeTwo");
  expect(one.status).toBe(200);
  expect(one.body.notification).toMatchObject({ notification_id: target.notification_id, is_read: true });
  expect(one.body.unreadCount).toBe(before.unreadCount - 1);
  expect((await call("get", "/api/notifications/unread-count", "attendeeTwo")).body.unreadCount).toBe(before.unreadCount - 1);

  const all = await call("post", "/api/notifications/read-all", "attendeeTwo");
  expect(all.status).toBe(200);
  expect(all.body).toEqual({ updated: before.unreadCount - 1, unreadCount: 0 });
  // The other attendee's inbox is untouched.
  expect((await inboxFor("attendee")).unreadCount).toBeGreaterThan(0);
});

test("[SPM-155-TC-12] signed-out requests are refused", async () => {
  const res = await request(app).get("/api/notifications");
  expect(res.status).toBe(401);
});

describe("[SPM-155 AC4/AC5] GET /api/registrations/mine/:eventId", () => {
  // The discovery detail fields (SPM-34), unchanged on GET /api/events/discovery/:id.
  const DISCOVERY_DETAIL_FIELDS = [
    "description", "endDatetime", "eventId", "location", "organisationName",
    "registrationAvailability", "registrationCloseAt", "registrationOpenAt", "startDatetime", "title",
  ];
  const EVENT_FIELDS = [...DISCOVERY_DETAIL_FIELDS, "attendeeStatus", "detailsWithheld"].sort();

  test("withholds a cancelled event's details from its waitlisted attendee and hides it from everyone else", async () => {
    const eventId = await createEvent("Cancelled Details", { status: "CANCELLED" });
    await createRegistration("attendee", eventId, "WAITLISTED");

    const mine = await call("get", `/api/registrations/mine/${eventId}`, "attendee");
    expect(mine.status).toBe(200);
    expect(Object.keys(mine.body).sort()).toEqual(["event", "myRegistration"]);
    expect(Object.keys(mine.body.event).sort()).toEqual(EVENT_FIELDS);
    expect(mine.body.event).toMatchObject({
      eventId,
      attendeeStatus: "CANCELLED",
      detailsWithheld: true,
      description: null,
      startDatetime: null,
      endDatetime: null,
      location: null,
      organisationName: null,
    });
    expect(mine.body.myRegistration).toEqual({ status: "WAITLISTED", registeredAt: expect.any(String) });
    expect(JSON.stringify(mine.body)).not.toContain("Internal planning purpose");

    expect((await call("get", `/api/registrations/mine/${eventId}`, "attendeeTwo")).status).toBe(404);
    // Discovery keeps its own rules: a cancelled event is not discoverable.
    expect((await call("get", `/api/events/discovery/${eventId}`, "attendee")).status).toBe(404);
  });

  test("withholds details while an event is back in planning", async () => {
    const eventId = await createEvent("Planning Details", { status: "PLANNING" });
    await createRegistration("attendee", eventId);

    const res = await call("get", `/api/registrations/mine/${eventId}`, "attendee");
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ attendeeStatus: "PENDING_CONFIRMATION", detailsWithheld: true, startDatetime: null });
    expect(res.body.myRegistration.status).toBe("REGISTERED");
  });

  test("shows a past confirmed event to its registrant only", async () => {
    const eventId = await createEvent("Past Details", { startsInHours: -5 });
    await createRegistration("attendee", eventId, "REGISTERED", 10);

    const mine = await call("get", `/api/registrations/mine/${eventId}`, "attendee");
    expect(mine.status).toBe(200);
    expect(mine.body.event).toMatchObject({
      attendeeStatus: "CONFIRMED",
      detailsWithheld: false,
      description: "Public description for Past Details",
      startDatetime: expect.any(String),
    });
    expect((await call("get", `/api/registrations/mine/${eventId}`, "attendeeTwo")).status).toBe(404);
    expect((await call("get", `/api/events/discovery/${eventId}`, "attendee")).status).toBe(404);
  });

  test("answers 404 once the registration is withdrawn", async () => {
    const eventId = await createEvent("Withdrawn Details");
    await createRegistration("attendee", eventId, "WITHDRAWN");
    const res = await call("get", `/api/registrations/mine/${eventId}`, "attendee");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event request not found.", code: "EVENT_NOT_FOUND" });
  });

  test("[SPM-34] leaves the discovery detail exactly as on main for a registered attendee", async () => {
    const eventId = await createEvent("Discoverable Details");
    await createRegistration("attendee", eventId);
    const res = await call("get", `/api/events/discovery/${eventId}`, "attendee");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.event).sort()).toEqual([...DISCOVERY_DETAIL_FIELDS].sort());
  });
});

describe("SPM-158 reminders (rolled back)", () => {
  let dueEvent;

  beforeAll(async () => {
    dueEvent = await createEvent("Tomorrow Forum", { startsInHours: 23 });
    await createRegistration("attendee", dueEvent);
    await createRegistration("attendeeTwo", dueEvent, "REGISTERED", 0);
  });

  const withRolledBack = (operation) => withCleanupConnection(async (client) => {
    await client.query("BEGIN");
    try {
      return await operation(client);
    } finally {
      await client.query("ROLLBACK");
    }
  });
  const reminders = (client) => client.query(
    "SELECT nr.recipient_id FROM public.notification n JOIN public.notification_recipient nr USING (notification_id) WHERE n.event_id = $1 AND n.type = 'EVENT_REMINDER'",
    [dueEvent]
  ).then(({ rows }) => rows.map((row) => row.recipient_id));

  test("[SPM-155-TC-11] one reminder for the early registrant; a second run adds none", async () => {
    await withRolledBack(async (client) => {
      await client.query("SELECT public.send_due_event_reminders(500)");
      expect(await reminders(client)).toEqual([userId("attendee")]);
      await client.query("SELECT public.send_due_event_reminders(500)");
      expect(await reminders(client)).toEqual([userId("attendee")]);
    });
    expect((await supabase.from("notification").select("notification_id").eq("event_id", dueEvent)).data).toEqual([]);
  });

  test("[SPM-158] a parallel run skips rows another run has claimed", async () => {
    const second = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await second.connect();
    try {
      await withRolledBack(async (client) => {
        await client.query("SELECT public.send_due_event_reminders(500)");
        await second.query("BEGIN");
        try {
          await second.query("SET LOCAL lock_timeout = '5s'");
          await second.query("SELECT public.send_due_event_reminders(500)");
          expect(await reminders(second)).toEqual([]);
        } finally {
          await second.query("ROLLBACK");
        }
      });
    } finally {
      await second.end();
    }
  });
});
