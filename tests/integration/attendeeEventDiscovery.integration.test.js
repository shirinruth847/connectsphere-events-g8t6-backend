const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { bookPrimaryVenue } = require("../fixtures/registrationFixtures");
const {
  newRunId,
  createAuthFixtures,
  cleanupAuthFixtures,
  recordFixtureIds,
} = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const runId = newRunId();
let fixtures;
const sessions = new Map();
const listFields = [
  "description",
  "endDatetime",
  "eventId",
  "location",
  "organisationName",
  "registrationAvailability",
  "startDatetime",
  "title",
];
const detailFields = [...listFields, "registrationCloseAt", "registrationOpenAt"];

const signIn = async (accountKey) => {
  if (!sessions.has(accountKey)) {
    const account = fixtures.accounts[accountKey];
    sessions.set(accountKey, signInWithPassword(account.email, account.password).then(({ session, error }) => {
      if (error || !session) {
        throw new Error(`Sign-in for ${accountKey} failed: ${error ? `${error.status} ${error.code}` : "no session"}`);
      }
      return session;
    }));
  }
  return sessions.get(accountKey);
};

const callAs = async (method, path, accountKey = "attendee") => {
  const session = await signIn(accountKey);
  return request(app)[method](path).set("Authorization", `Bearer ${session.access_token}`);
};

// Follows nextCursor to the last page, so fixtures are found wherever the start-time order puts them.
const listAllDiscoveryEvents = async (limit = 100) => {
  const events = [];
  let cursor = null;
  do {
    const query = cursor ? `limit=${limit}&cursor=${cursor}` : `limit=${limit}`;
    const response = await callAs("get", `/api/events/discovery?${query}`);
    expect(response.status).toBe(200);
    events.push(...response.body.events);
    cursor = response.body.nextCursor;
  } while (cursor);
  return events;
};

const insertEvent = async (suffix, overrides = {}) => {
  const startsAt = Date.now() + 3 * 60 * 60 * 1000;
  const { data, error } = await supabase.from("event").insert({
    title: `spm34-${runId}-${suffix}`,
    description: `Public description for ${suffix}`,
    purpose: `Internal planning purpose for ${suffix}`,
    accessibility_needs: `Internal accessibility notes for ${suffix}`,
    organiser_id: fixtures.accounts.organiserA.userId,
    // Discovery never reads the coordinator, and these events share time slots that
    // one coordinator cannot hold together (SPM-174 schedule guard, COORDINATOR_CONFLICT).
    coordinator_id: null,
    organisation_id: fixtures.organisations.A,
    status: "CONFIRMED",
    start_datetime: new Date(startsAt).toISOString(),
    end_datetime: new Date(startsAt + 60 * 60 * 1000).toISOString(),
    expected_attendance: 25,
    preferred_layout_type: "THEATRE",
    is_published: true,
    is_registration_enabled: true,
    registration_capacity: 10,
    registration_open_at: null,
    registration_close_at: null,
    ...overrides,
  }).select("event_id").single();

  if (error) throw new Error(`Fixture event insert failed: ${error.message}`);
  recordFixtureIds(runId, "eventIds", [data.event_id]);
  return data.event_id;
};

// SPM-134 (Master 5.6): availability needs a registration period and a primary
// venue, whose capacity limits registration. Each event gets its own venue, so
// these events can share time slots.
const insertRegistrableEvent = async (suffix, overrides = {}, venueCapacity = 50) => {
  const eventId = await insertEvent(suffix, {
    registration_open_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    registration_close_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
  const { data, error } = await supabase.from("event").select("start_datetime,end_datetime").eq("event_id", eventId).single();
  if (error) throw new Error(`Fixture event read failed: ${error.message}`);
  await bookPrimaryVenue(runId, {
    eventId,
    requestedBy: fixtures.accounts.organiserA.userId,
    startDatetime: data.start_datetime,
    endDatetime: data.end_datetime,
    capacity: venueCapacity,
  });
  return eventId;
};

const insertRegistration = async (eventId, accountKey, status) => {
  const { data, error } = await supabase.from("registration").insert({
    event_id: eventId,
    attendee_id: fixtures.accounts[accountKey].userId,
    registration_status: status,
  }).select("registration_id").single();

  if (error) throw new Error(`Fixture registration insert failed: ${error.message}`);
  recordFixtureIds(runId, "registrationIds", [data.registration_id]);
};

const findUnknownEventId = async () => {
  for (let candidate = 2147483647; candidate > 2147483637; candidate -= 1) {
    const { data, error } = await supabase.from("event").select("event_id").eq("event_id", candidate).maybeSingle();
    if (error) throw new Error(`Unknown-ID lookup failed: ${error.message}`);
    if (!data) return String(candidate);
  }
  throw new Error("Unable to find an unused event ID for the 404 test.");
};

beforeAll(async () => {
  fixtures = await createAuthFixtures(runId);
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("[SPM-88] attendee event discovery and detail visibility", () => {
  test("[SPM-126] should_list_only_published_confirmed_future_events", async () => {
    const visibleId = await insertEvent("visible-list-event");
    const hiddenIds = [];

    for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "AWAITING_CLARIFICATION", "PLANNING", "COMPLETED", "CANCELLED", "REJECTED"]) {
      hiddenIds.push(await insertEvent(`hidden-${status.toLowerCase()}`, { status }));
    }
    hiddenIds.push(await insertEvent("unpublished", { is_published: false }));

    const past = Date.now() - 3 * 60 * 60 * 1000;
    hiddenIds.push(await insertEvent("past-list-event", {
      start_datetime: new Date(past - 60 * 60 * 1000).toISOString(),
      end_datetime: new Date(past).toISOString(),
    }));

    const visibleIds = (await listAllDiscoveryEvents()).map(({ eventId }) => eventId);
    expect(visibleIds).toContain(visibleId);

    for (const eventId of hiddenIds) {
      expect(visibleIds).not.toContain(eventId);
      const detail = await callAs("get", `/api/events/discovery/${eventId}`);
      expect(detail.status).toBe(404);
    }
  });

  test("[SPM-34-AC1] should_return_an_empty_event_page_with_a_null_cursor", async () => {
    const cursor = Buffer.from(JSON.stringify({
      startDatetime: "9999-12-31T23:59:59.000Z",
      eventId: 2147483647,
    })).toString("base64url");
    const response = await callAs("get", `/api/events/discovery?cursor=${cursor}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ events: [], nextCursor: null });
  });

  test("[SPM-126] should_return_the_same_404_for_unknown_hidden_uuid_and_malformed_ids", async () => {
    const hiddenId = await insertEvent("unpublished-detail", { is_published: false });
    const unknownId = await findUnknownEventId();
    const paths = [
      `/api/events/discovery/${unknownId}`,
      `/api/events/discovery/${hiddenId}`,
      "/api/events/discovery/550e8400-e29b-41d4-a716-446655440000",
      "/api/events/discovery/not-an-id",
    ];
    const responses = [];

    for (const path of paths) responses.push(await callAs("get", path));

    for (const response of responses) expect(response.status).toBe(404);
    for (const response of responses.slice(1)) expect(response.body).toEqual(responses[0].body);
  });

  test("[SPM-126] should_return_404_for_past_events_in_detail", async () => {
    const past = Date.now() - 3 * 60 * 60 * 1000;
    const eventId = await insertEvent("past-detail-event", {
      start_datetime: new Date(past - 60 * 60 * 1000).toISOString(),
      end_datetime: new Date(past).toISOString(),
    });
    const response = await callAs("get", `/api/events/discovery/${eventId}`);

    expect(response.status).toBe(404);
  });

  test("[SPM-34-AC5] should_return_only_allowlisted_fields_and_keep_pending_location_null", async () => {
    const eventId = await insertEvent("allowlisted-projection");
    const detailResponse = await callAs("get", `/api/events/discovery/${eventId}`);
    expect(detailResponse.status).toBe(200);
    const listItem = (await listAllDiscoveryEvents()).find((event) => event.eventId === eventId);

    expect(Object.keys(detailResponse.body.event).sort()).toEqual([...detailFields].sort());
    expect(detailResponse.body.event.location).toBeNull();
    expect(Object.keys(listItem).sort()).toEqual([...listFields].sort());
    expect(listItem.location).toBeNull();
  });

  test("[SPM-34-AC1/AC5] should_show_an_approved_venue_in_list_and_detail", async () => {
    const start = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();
    const eventId = await insertEvent("approved-location", { start_datetime: start, end_datetime: end });
    const { data, error } = await supabase.from("venue_booking").insert({
      event_id: eventId,
      room_id: fixtures.venue.roomId,
      requested_by: fixtures.accounts.coordinator.userId,
      start_datetime: start,
      end_datetime: end,
      status: "APPROVED",
    }).select("booking_id").single();
    if (error) throw new Error(`Fixture booking insert failed: ${error.message}`);
    recordFixtureIds(runId, "bookingIds", [data.booking_id]);

    const response = await callAs("get", `/api/events/discovery/${eventId}`);
    const item = (await listAllDiscoveryEvents()).find((event) => event.eventId === eventId);
    const location = `spm32-${runId} Hall, spm32-${runId} 1 Test Road`;
    expect(response.status).toBe(200);
    expect(response.body.event.location).toBe(location);
    expect(item.location).toBe(location);
    expect(Object.keys(response.body.event).sort()).toEqual([...detailFields].sort());
    expect(Object.keys(item).sort()).toEqual([...listFields].sort());
  });

  test("[SPM-34-AC1] should_list_soonest_start_first_and_page_without_skipping_or_repeating", async () => {
    const sharedStart = Date.now() + 5 * 60 * 60 * 1000;
    const at = (offsetMs) => ({
      start_datetime: new Date(sharedStart + offsetMs).toISOString(),
      end_datetime: new Date(sharedStart + offsetMs + 60 * 60 * 1000).toISOString(),
    });
    const later = await insertEvent("order-later", at(60_000));
    const tieFirst = await insertEvent("order-tie-first", at(0));
    const tieSecond = await insertEvent("order-tie-second", at(0));
    const earliest = await insertEvent("order-earliest", at(-60_000));

    const events = await listAllDiscoveryEvents(1);
    const ids = events.map(({ eventId }) => eventId);
    const keys = events.map(({ startDatetime, eventId }) => [Date.parse(startDatetime), eventId]);
    const sorted = [...keys].sort(([aStart, aId], [bStart, bId]) => aStart - bStart || aId - bId);

    expect(new Set(ids).size).toBe(ids.length);
    expect(keys).toEqual(sorted);
    expect(ids.filter((id) => [later, tieFirst, tieSecond, earliest].includes(id)))
      .toEqual([earliest, tieFirst, tieSecond, later]);
  });

  test("[SPM-34-AC6] should_show_latest_published_details_after_an_event_update", async () => {
    const eventId = await insertEvent("latest-details");
    const { error } = await supabase.from("event").update({
      title: `spm34-${runId}-latest-title`,
      description: "Latest published attendee description",
    }).eq("event_id", eventId);
    expect(error).toBeNull();

    const response = await callAs("get", `/api/events/discovery/${eventId}`);
    expect(response.status).toBe(200);
    expect(response.body.event.title).toBe(`spm34-${runId}-latest-title`);
    expect(response.body.event.description).toBe("Latest published attendee description");
  });
});

describe("[SPM-34-AC1] attendee-only access", () => {
  test.each([
    ["organiserA", "ORGANISER"],
    ["coordinator", "COORDINATOR"],
    ["coordinatorLead", "COORDINATOR_LEAD"],
    ["venueStaff", "VENUE_STAFF"],
    ["techSupport", "TECH_SUPPORT"],
  ])("should_return_403_on_discovery_endpoints_for_%s_%s", async (accountKey) => {
    const eventId = fixtures.events.registeredConfirmed;
    const listResponse = await callAs("get", "/api/events/discovery", accountKey);
    const detailResponse = await callAs("get", `/api/events/discovery/${eventId}`, accountKey);

    expect(listResponse.status).toBe(403);
    expect(detailResponse.status).toBe(403);
  });
});

describe("[SPM-34-AC3] attendee registration availability", () => {
  // SPM-134 final rule (Master 5.6, 30 October 2026) supersedes AC3 here: the
  // registration start and end times and the primary venue's capacity decide
  // availability; the enabled flag does not.
  test("[SPM-134] should_report_open_when_attendee_registration_is_disabled", async () => {
    const eventId = await insertRegistrableEvent("registration-disabled", {
      is_registration_enabled: false,
      registration_capacity: null,
    });
    const response = await callAs("get", `/api/events/discovery/${eventId}`);

    expect(response.status).toBe(200);
    expect(response.body.event.registrationAvailability).toBe("OPEN");
  });

  test("[SPM-134] should_report_unavailable_when_the_registration_period_or_primary_venue_is_missing", async () => {
    const noPeriod = await insertEvent("registration-no-period");
    const noVenue = await insertEvent("registration-no-venue", {
      registration_open_at: new Date(Date.now() - 60_000).toISOString(),
      registration_close_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    for (const eventId of [noPeriod, noVenue]) {
      const response = await callAs("get", `/api/events/discovery/${eventId}`);
      expect(response.status).toBe(200);
      expect(response.body.event.registrationAvailability).toBe("UNAVAILABLE");
    }
  });

  test("[SPM-126] should_reject_enabled_registration_without_capacity_without_persisting_an_event", async () => {
    const title = `spm34-${runId}-registration-without-capacity`;
    const { data, error } = await supabase.from("event").insert({
      title,
      description: "Event used to verify the registration capacity constraint",
      purpose: "Synthetic test-only row",
      organiser_id: fixtures.accounts.organiserA.userId,
      coordinator_id: null,
      organisation_id: fixtures.organisations.A,
      status: "CONFIRMED",
      start_datetime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      end_datetime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      expected_attendance: 25,
      preferred_layout_type: "THEATRE",
      is_published: true,
      is_registration_enabled: true,
      registration_capacity: null,
      registration_open_at: null,
      registration_close_at: null,
    }).select("event_id").maybeSingle();
    const { data: persisted, error: lookupError } = await supabase
      .from("event")
      .select("event_id")
      .eq("title", title)
      .maybeSingle();

    expect(error).toEqual(expect.objectContaining({ code: "23514" }));
    expect(data).toBeNull();
    expect(lookupError).toBeNull();
    expect(persisted).toBeNull();
  });

  test("[SPM-134] should_report_not_yet_open_before_the_start_and_closed_from_the_end_in_list_and_detail", async () => {
    const beforeOpenId = await insertRegistrableEvent("registration-before-open", {
      registration_open_at: new Date(Date.now() + 60_000).toISOString(),
      registration_close_at: new Date(Date.now() + 120_000).toISOString(),
    });
    const afterCloseId = await insertRegistrableEvent("registration-after-close", {
      registration_open_at: new Date(Date.now() - 120_000).toISOString(),
      registration_close_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const beforeOpen = await callAs("get", `/api/events/discovery/${beforeOpenId}`);
    const afterClose = await callAs("get", `/api/events/discovery/${afterCloseId}`);
    const list = await listAllDiscoveryEvents();

    expect(beforeOpen.status).toBe(200);
    expect(afterClose.status).toBe(200);
    expect(beforeOpen.body.event.registrationAvailability).toBe("NOT_YET_OPEN");
    expect(afterClose.body.event.registrationAvailability).toBe("CLOSED");
    expect(list.find((event) => event.eventId === beforeOpenId).registrationAvailability).toBe("NOT_YET_OPEN");
    expect(list.find((event) => event.eventId === afterCloseId).registrationAvailability).toBe("CLOSED");
  });

  test("should_report_full_when_registered_count_reaches_capacity", async () => {
    const eventId = await insertRegistrableEvent("registration-full", { registration_capacity: 1 });
    await insertRegistration(eventId, "attendee", "REGISTERED");
    const response = await callAs("get", `/api/events/discovery/${eventId}`);
    const listItem = (await listAllDiscoveryEvents()).find((event) => event.eventId === eventId);

    expect(response.status).toBe(200);
    expect(response.body.event.registrationAvailability).toBe("FULL_WAITLIST");
    expect(listItem.registrationAvailability).toBe("FULL_WAITLIST");
  });

  test("should_not_count_waitlisted_or_withdrawn_registrations_toward_capacity", async () => {
    const eventId = await insertRegistrableEvent("registration-status-count", { registration_capacity: 2 });
    await insertRegistration(eventId, "attendee", "REGISTERED");
    await insertRegistration(eventId, "deactivatable", "WAITLISTED");
    await insertRegistration(eventId, "inactive", "WITHDRAWN");
    const response = await callAs("get", `/api/events/discovery/${eventId}`);
    const listItem = (await listAllDiscoveryEvents()).find((event) => event.eventId === eventId);

    expect(response.status).toBe(200);
    expect(response.body.event.registrationAvailability).toBe("OPEN");
    expect(listItem.registrationAvailability).toBe("OPEN");
  });

  // Master 1.5 / SPM-44: attendee discovery shows only CONFIRMED events.
  test("[SPM-44] should_hide_a_published_preparation_event_from_list_and_detail", async () => {
    const { data, error } = await supabase.from("event").insert({
      title: `spm34-${runId}-preparation`,
      description: "Published preparation event",
      purpose: "Internal preparation notes",
      organiser_id: fixtures.accounts.organiserA.userId,
      coordinator_id: null,
      organisation_id: fixtures.organisations.A,
      status: "PREPARATION",
      start_datetime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      end_datetime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      expected_attendance: 25,
      preferred_layout_type: "THEATRE",
      is_published: true,
      is_registration_enabled: true,
      registration_capacity: 10,
    }).select("event_id").single();

    expect(error).toBeNull();
    if (error) return;
    recordFixtureIds(runId, "eventIds", [data.event_id]);

    const events = await listAllDiscoveryEvents();
    const detailResponse = await callAs("get", `/api/events/discovery/${data.event_id}`);
    expect(events.some((event) => event.eventId === data.event_id)).toBe(false);
    expect(detailResponse.status).toBe(404);
    expect(detailResponse.body).toEqual({ error: "Event request not found.", code: "EVENT_NOT_FOUND" });
  });
});
