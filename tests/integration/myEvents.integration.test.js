// SPM-141 My Events live integration tests: real Express routes, middleware,
// Supabase Auth and the shared development database from .env. Nothing is
// mocked. Fixtures are synthetic, namespaced by run ID and listed in the
// manifest. Confirmation snapshots can only be written by the database owner,
// so they are inserted through TEST_DATABASE_URL as trusted setup (as in
// notifications.integration.test.js) and removed before the events.
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { createRegistrationFixtures, bookPrimaryVenue } = require("../fixtures/registrationFixtures");
const { withCleanupConnection } = require("../fixtures/adminCleanup");

jest.setTimeout(300000);

const runId = newRunId();
const DAY = 24 * 60 * 60 * 1000;
const NON_ATTENDEES = ["organiserA", "coordinator", "coordinatorLead", "venueStaff", "techSupport", "safetyOfficer"];
const ROW_KEYS = ["event", "offer", "registered_at", "registration_id", "registration_status", "waitlistPosition"];
const EVENT_KEYS = ["attendee_status", "description", "end_datetime", "event_id", "start_datetime", "title", "venue"];
const PRIVATE_ANSWER = "Synthetic private dietary answer";
const INTERNAL_PURPOSE = "Synthetic internal planning purpose";

let fixtures;
let eventOffset = 0;
const events = {};
const snapshotEventIds = [];
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
const getAs = async (key, path) => request(app).get(path).set("Authorization", `Bearer ${(await signIn(key)).access_token}`);
const postAs = async (key, path, body = {}) =>
  request(app).post(path).set("Authorization", `Bearer ${(await signIn(key)).access_token}`).send(body);
const asOwner = (sql, values = []) => withCleanupConnection(async (client) => (await client.query(sql, values)).rows);

const listAll = async (key) => {
  const res = await getAs(key, "/api/registrations/mine?limit=100");
  expect(res.status).toBe(200);
  expect(res.body.page.next_offset).toBeNull();
  return res.body.registrations;
};
const rowFor = async (key, eventId) => (await listAll(key)).find((row) => row.event.event_id === eventId);

// Each event gets its own day and, unless venueCapacity is null, its own
// primary venue. Every active state after SUBMITTED has a coordinator.
const insertEvent = async (overrides = {}, { venueCapacity = 50 } = {}) => {
  eventOffset += 1;
  const startsAt = Date.now() + (20 + eventOffset) * DAY;
  const { data, error } = await supabase.from("event").insert({
    title: `spm141-${runId}-event-${eventOffset}`,
    description: `spm141-${runId} current description ${eventOffset}`,
    purpose: INTERNAL_PURPOSE,
    organiser_id: fixtures.accounts.organiserA.userId,
    coordinator_id: fixtures.accounts.coordinator.userId,
    organisation_id: fixtures.organisations.A,
    status: "CONFIRMED",
    start_datetime: new Date(startsAt).toISOString(),
    end_datetime: new Date(startsAt + 2 * 60 * 60 * 1000).toISOString(),
    expected_attendance: 25,
    preferred_layout_type: "THEATRE",
    is_published: true,
    is_registration_enabled: true,
    registration_capacity: 10,
    registration_open_at: new Date(Date.now() - DAY).toISOString(),
    registration_close_at: new Date(startsAt - DAY).toISOString(),
    ...overrides,
  }).select("event_id,start_datetime,end_datetime").single();
  if (error) throw new Error(`Fixture event insert failed: ${error.message}`);
  recordFixtureIds(runId, "eventIds", [data.event_id]);
  if (venueCapacity !== null) {
    await bookPrimaryVenue(runId, {
      eventId: data.event_id,
      requestedBy: fixtures.accounts.organiserA.userId,
      startDatetime: data.start_datetime,
      endDatetime: data.end_datetime,
      capacity: venueCapacity,
    });
  }
  return data.event_id;
};

// A second approved, non-primary booking at another venue.
const bookSecondVenue = async (eventId) => {
  const check = ({ data, error }, step) => {
    if (error) throw new Error(`Fixture step "${step}" failed: ${error.message}`);
    return data;
  };
  const { start_datetime: startDatetime, end_datetime: endDatetime } = check(
    await supabase.from("event").select("start_datetime,end_datetime").eq("event_id", eventId).single(),
    "event times"
  );
  const venueId = check(
    await supabase.from("venue").insert({ name: `spm32-${runId} Annex ${eventId}`, address: "2 Synthetic Street", max_capacity: 40 })
      .select("venue_id").single(),
    "second venue"
  ).venue_id;
  recordFixtureIds(runId, "venueIds", [venueId]);
  const roomId = check(
    await supabase.from("room").insert({ venue_id: venueId, layout_type: "THEATRE", capacity: 40 }).select("room_id").single(),
    "second room"
  ).room_id;
  recordFixtureIds(runId, "roomIds", [roomId]);
  const bookingId = check(
    await supabase.from("venue_booking").insert({
      event_id: eventId,
      room_id: roomId,
      requested_by: fixtures.accounts.organiserA.userId,
      start_datetime: startDatetime,
      end_datetime: endDatetime,
      status: "APPROVED",
      is_primary: false,
      reviewed_at: new Date().toISOString(),
    }).select("booking_id").single(),
    "second booking"
  ).booking_id;
  recordFixtureIds(runId, "bookingIds", [bookingId]);
};

const insertRegistration = async (eventId, accountKey, status, answers = {}) => {
  const { data, error } = await supabase.from("registration").insert({
    event_id: eventId,
    attendee_id: fixtures.accounts[accountKey].userId,
    registration_status: status,
    ...answers,
  }).select("registration_id").single();
  if (error) throw new Error(`Fixture registration insert failed: ${error.message}`);
  recordFixtureIds(runId, "registrationIds", [data.registration_id]);
  return data.registration_id;
};

const confirmedValues = (eventOffsetLabel, overrides = {}) => ({
  is_published: true,
  title: `spm141-${runId} confirmed title ${eventOffsetLabel}`,
  description: `spm141-${runId} confirmed description ${eventOffsetLabel}`,
  start_datetime: "2027-06-01T09:00:00+00:00",
  end_datetime: "2027-06-01T11:00:00+00:00",
  registration_open_at: "2027-05-01T09:00:00+00:00",
  registration_close_at: "2027-05-31T09:00:00+00:00",
  registration_capacity: 77,
  primary_venue: { venue_id: 987654, name: `spm141-${runId} Confirmed Hall`, address: "9 Confirmed Road" },
  ...overrides,
});

const insertSnapshot = async (eventId, snapshot) => {
  if (!snapshotEventIds.includes(eventId)) snapshotEventIds.push(eventId);
  await asOwner(
    `INSERT INTO public.event_confirmation_snapshots (event_id, event_version, arrangement_version, snapshot, confirmed_by)
     SELECT e.event_id, e.version, e.arrangement_version, $2::jsonb, $3 FROM public.event AS e WHERE e.event_id = $1`,
    [eventId, JSON.stringify(snapshot), fixtures.accounts.coordinator.userId]
  );
};

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for the SPM-141 integration tests.");
  fixtures = await createRegistrationFixtures(runId, [
    { key: "attendee", role: "ATTENDEE" },
    { key: "otherAttendee", role: "ATTENDEE" },
    { key: "inactiveAttendee", role: "ATTENDEE" },
    { key: "organiserA", role: "ORGANISER", organisation: "A" },
    { key: "coordinator", role: "COORDINATOR" },
    { key: "coordinatorLead", role: "COORDINATOR_LEAD" },
    { key: "venueStaff", role: "VENUE_STAFF" },
    { key: "techSupport", role: "TECH_SUPPORT" },
    { key: "safetyOfficer", role: "SAFETY_OFFICER" },
  ]);
  // Trusted setup on this run's own row: an attendee whose account was deactivated.
  const { error } = await supabase
    .from("user")
    .update({ is_active: false })
    .eq("user_id", fixtures.accounts.inactiveAttendee.userId)
    .like("email", `spm32-${runId}-%`);
  if (error) throw error;

  events.unpublished = await insertEvent({ is_published: false });
  events.preparation = await insertEvent({ status: "PREPARATION" });
  events.twoVenues = await insertEvent();
  await bookSecondVenue(events.twoVenues);
  events.planningSnapshot = await insertEvent({ status: "PLANNING", title: `spm141-${runId} unconfirmed new title` });
  await insertSnapshot(events.planningSnapshot, confirmedValues("older", { title: `spm141-${runId} superseded title` }));
  await insertSnapshot(events.planningSnapshot, confirmedValues("planning"));
  events.safetySnapshot = await insertEvent({ status: "SAFETY_REVIEW" });
  await insertSnapshot(events.safetySnapshot, confirmedValues("safety"));
  events.cancelledSnapshot = await insertEvent({ status: "CANCELLED" }, { venueCapacity: null });
  await insertSnapshot(events.cancelledSnapshot, confirmedValues("cancelled"));
  events.unpublishedSnapshot = await insertEvent({ status: "PLANNING" });
  await insertSnapshot(events.unpublishedSnapshot, confirmedValues("hidden", { is_published: false }));
  events.planningNoSnapshot = await insertEvent({ status: "PLANNING" });
  for (const key of Object.keys(events)) {
    await insertRegistration(events[key], "attendee", key === "safetySnapshot" ? "WAITLISTED" : "REGISTERED", {
      dietary_restrictions: PRIVATE_ANSWER,
    });
  }
});

// Runs even when setup stopped part-way: the manifest lists what was created.
afterAll(async () => {
  if (snapshotEventIds.length) {
    await asOwner("DELETE FROM public.event_confirmation_snapshots WHERE event_id = ANY($1::integer[])", [snapshotEventIds]);
  }
  await cleanupAuthFixtures(runId);
});

describe("[SPM-141] My Events event values follow the attendee event page", () => {
  test("[SPM-141][AC8] should_withhold_current_values_when_a_confirmed_event_is_unpublished", async () => {
    const row = await rowFor("attendee", events.unpublished);
    expect(row.registration_status).toBe("REGISTERED");
    expect(row.event).toEqual({
      event_id: events.unpublished,
      title: expect.stringContaining(`spm141-${runId}-event-`),
      description: null,
      start_datetime: null,
      end_datetime: null,
      attendee_status: "CONFIRMED",
      venue: null,
    });
  });

  test("[SPM-141][TC-MYE-001] should_show_current_values_and_venue_as_confirmed_when_a_published_event_is_in_preparation", async () => {
    const { event } = await rowFor("attendee", events.preparation);
    expect(event.attendee_status).toBe("CONFIRMED");
    expect(event.description).toContain("current description");
    expect(event.start_datetime).not.toBeNull();
    expect(event.venue).toEqual({ name: `spm32-${runId} Venue ${events.preparation}`, address: "1 Synthetic Street" });
  });

  test("[SPM-141][AC1] should_show_no_venue_when_the_event_has_two_approved_venues", async () => {
    const { event } = await rowFor("attendee", events.twoVenues);
    expect(event.start_datetime).not.toBeNull();
    expect(event.venue).toBeNull();
  });

  test("[SPM-141][Master 5.3] should_show_the_latest_published_snapshot_when_a_confirmed_event_is_back_in_planning", async () => {
    const { event } = await rowFor("attendee", events.planningSnapshot);
    expect(event).toEqual({
      event_id: events.planningSnapshot,
      title: `spm141-${runId} confirmed title planning`,
      description: `spm141-${runId} confirmed description planning`,
      start_datetime: "2027-06-01T09:00:00+00:00",
      end_datetime: "2027-06-01T11:00:00+00:00",
      attendee_status: "PENDING_CONFIRMATION",
      venue: { name: `spm141-${runId} Confirmed Hall`, address: "9 Confirmed Road" },
    });
  });

  test("[SPM-141][TC-MYE-002] should_show_the_snapshot_beside_the_waitlisted_place_when_the_event_is_in_safety_review", async () => {
    const row = await rowFor("attendee", events.safetySnapshot);
    expect(row.registration_status).toBe("WAITLISTED");
    expect(row.waitlistPosition).toBe(1);
    expect(row.event).toMatchObject({
      title: `spm141-${runId} confirmed title safety`,
      start_datetime: "2027-06-01T09:00:00+00:00",
      attendee_status: "PENDING_CONFIRMATION",
    });
  });

  test("[SPM-141][TC-MYE-003] should_keep_cancelled_event_status_apart_from_the_place_when_a_confirmed_event_is_cancelled", async () => {
    const row = await rowFor("attendee", events.cancelledSnapshot);
    expect(row.registration_status).toBe("REGISTERED");
    expect(row.event).toMatchObject({
      attendee_status: "CANCELLED",
      title: `spm141-${runId} confirmed title cancelled`,
      start_datetime: "2027-06-01T09:00:00+00:00",
      venue: { name: `spm141-${runId} Confirmed Hall`, address: "9 Confirmed Road" },
    });
  });

  test.each([
    ["unpublishedSnapshot", "the only snapshot was taken while unpublished"],
    ["planningNoSnapshot", "the event was never confirmed"],
  ])("[SPM-141][AC8] should_withhold_current_values_when_%s_(%s)", async (key) => {
    const { event } = await rowFor("attendee", events[key]);
    expect(event).toMatchObject({ description: null, start_datetime: null, end_datetime: null, venue: null, attendee_status: "PENDING_CONFIRMATION" });
    expect(event.title).toContain(`spm141-${runId}-event-`);
  });

  test("[SPM-141][TC-MYE-004] should_match_the_event_page_for_every_listed_event", async () => {
    const rows = await listAll("attendee");
    expect(rows).toHaveLength(Object.keys(events).length);
    for (const { event } of rows) {
      const page = await getAs("attendee", `/api/registrations/mine/${event.event_id}`);
      expect(page.status).toBe(200);
      const detail = page.body.event;
      expect({
        title: detail.title,
        description: detail.description,
        start_datetime: detail.startDatetime,
        end_datetime: detail.endDatetime,
        attendee_status: detail.attendeeStatus,
        location: detail.location,
      }).toEqual({
        title: event.title,
        description: event.description,
        start_datetime: event.start_datetime,
        end_datetime: event.end_datetime,
        attendee_status: event.attendee_status,
        location: event.venue ? [event.venue.name, event.venue.address].filter(Boolean).join(", ") : null,
      });
    }
  });
});

describe("[SPM-141] My Events never leaks internal or other attendees' data", () => {
  test("[SPM-141][TC-MYE-011] should_return_only_attendee_safe_keys_when_places_hold_private_answers_and_snapshots", async () => {
    const res = await getAs("attendee", "/api/registrations/mine?limit=100");
    expect(res.status).toBe(200);
    for (const row of res.body.registrations) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
      expect(Object.keys(row.event).sort()).toEqual(EVENT_KEYS);
      if (row.event.venue) expect(Object.keys(row.event.venue).sort()).toEqual(["address", "name"]);
    }
    const body = JSON.stringify(res.body);
    for (const leaked of [PRIVATE_ANSWER, INTERNAL_PURPOSE, "superseded title", "unconfirmed new title", "987654", "registration_capacity", "attendee_id"]) {
      expect(body).not.toContain(leaked);
    }
  });

  test("[SPM-141][TC-MYE-011] should_return_an_empty_page_when_another_attendee_holds_every_place", async () => {
    const res = await getAs("otherAttendee", "/api/registrations/mine");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrations: [], page: { limit: 50, offset: 0, next_offset: null } });
  });

  test("[SPM-141][TC-MYE-011] should_refuse_another_attendee's_event_page_as_not_found", async () => {
    const res = await getAs("otherAttendee", `/api/registrations/mine/${events.preparation}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
  });

  test("[SPM-141][TC-MYE-011] should_ignore_an_attendee_id_query_when_listing_places", async () => {
    const res = await getAs("otherAttendee", `/api/registrations/mine?attendee_id=${fixtures.accounts.attendee.userId}`);
    expect(res.status).toBe(200);
    expect(res.body.registrations).toEqual([]);
  });
});

describe("[SPM-141] My Events access", () => {
  test.each(NON_ATTENDEES)("[SPM-141][TC-MYE-012] should_refuse_the_list_and_event_page_when_the_role_is_%s", async (key) => {
    for (const path of ["/api/registrations/mine", `/api/registrations/mine/${events.preparation}`]) {
      const res = await getAs(key, path);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    }
  });

  test("[SPM-141][TC-MYE-012] should_answer_401_when_the_attendee_account_is_deactivated", async () => {
    expect((await getAs("inactiveAttendee", "/api/registrations/mine")).status).toBe(401);
  });

  test.each([
    ["no token", null],
    ["a malformed token", "Bearer not-a-jwt"],
  ])("[SPM-141][TC-MYE-012] should_answer_401_when_the_request_has_%s", async (_label, header) => {
    const req = request(app).get("/api/registrations/mine");
    if (header) req.set("Authorization", header);
    expect((await req).status).toBe(401);
  });
});

describe("[SPM-141] My Events pagination", () => {
  test("[SPM-141][TC-MYE-013] should_return_every_place_once_when_walking_single_place_pages", async () => {
    const seen = [];
    let offset = 0;
    for (let page = 0; page < 20 && offset !== null; page += 1) {
      const res = await getAs("attendee", `/api/registrations/mine?limit=1&offset=${offset}`);
      expect(res.status).toBe(200);
      expect(res.body.registrations.length).toBeLessThanOrEqual(1);
      seen.push(...res.body.registrations.map((row) => row.registration_id));
      offset = res.body.page.next_offset;
    }
    expect(offset).toBeNull();
    expect(seen).toEqual((await listAll("attendee")).map((row) => row.registration_id));
    expect(new Set(seen).size).toBe(Object.keys(events).length);
  });

  test("[SPM-141][TC-MYE-013] should_return_an_empty_last_page_when_the_offset_is_past_the_end", async () => {
    const res = await getAs("attendee", "/api/registrations/mine?offset=500");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrations: [], page: { limit: 50, offset: 500, next_offset: null } });
  });

  test.each(["limit=0", "limit=101", "limit=abc", "offset=-1", "offset=10001", "offset=1.5"])(
    "[SPM-141][TC-MYE-013] should_refuse_with_validation_failed_when_the_query_is_%s",
    async (query) => {
      const res = await getAs("attendee", `/api/registrations/mine?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_FAILED");
    }
  );
});

describe("[SPM-141] waitlist offers come from backend state", () => {
  test("[SPM-141][TC-MYE-008][AC6] should_drop_the_offer_when_its_deadline_has_passed_by_database_time", async () => {
    const eventId = await insertEvent({ registration_capacity: 1 });
    await insertRegistration(eventId, "otherAttendee", "REGISTERED");
    const joined = await postAs("attendee", `/api/registrations/mine/${eventId}/waitlist`, {
      dietaryRestrictions: null,
      accessibilityRequirements: null,
    });
    expect(joined.status).toBe(201);
    recordFixtureIds(runId, "registrationIds", [joined.body.registration.registrationId]);
    expect((await postAs("otherAttendee", `/api/registrations/mine/${eventId}/withdraw`)).status).toBe(200);
    const offered = await rowFor("attendee", eventId);
    expect(offered.offer).toEqual({ offerId: expect.any(Number), expiresAt: expect.any(String) });

    // Trusted setup on this run's own offer: its deadline passes, before any expiry job runs.
    await asOwner(
      `UPDATE public.waitlist_offer SET offered_at = now() - interval '25 hours', expires_at = now() - interval '1 minute'
        WHERE offer_id = $1 AND state = 'OPEN'`,
      [offered.offer.offerId]
    );
    const overdue = await rowFor("attendee", eventId);
    expect(overdue).toMatchObject({ registration_status: "WAITLISTED", waitlistPosition: 1, offer: null });
    const accept = await postAs("attendee", `/api/registrations/mine/${eventId}/offer/accept`, { offerId: offered.offer.offerId });
    expect(accept.status).toBe(409);
    expect(accept.body.code).toBe("OFFER_EXPIRED");
  });
});
