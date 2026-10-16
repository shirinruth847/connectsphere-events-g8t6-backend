const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
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
    coordinator_id: fixtures.accounts.coordinator.userId,
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
  test("should_report_not_enabled_when_attendee_registration_is_disabled", async () => {
    const eventId = await insertEvent("registration-disabled", {
      is_registration_enabled: false,
      registration_capacity: null,
    });
    const response = await callAs("get", `/api/events/discovery/${eventId}`);

    expect(response.status).toBe(200);
    expect(response.body.event.registrationAvailability).toBe("NOT_ENABLED");
  });

  test("[SPM-126] should_reject_enabled_registration_without_capacity_without_persisting_an_event", async () => {
    const title = `spm34-${runId}-registration-without-capacity`;
    const { data, error } = await supabase.from("event").insert({
      title,
      description: "Event used to verify the registration capacity constraint",
      purpose: "Synthetic test-only row",
      organiser_id: fixtures.accounts.organiserA.userId,
      coordinator_id: fixtures.accounts.coordinator.userId,
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

  test("should_report_closed_before_open_and_after_close", async () => {
    const beforeOpenId = await insertEvent("registration-before-open", {
      registration_open_at: new Date(Date.now() + 60_000).toISOString(),
      registration_close_at: new Date(Date.now() + 120_000).toISOString(),
    });
    const afterCloseId = await insertEvent("registration-after-close", {
      registration_open_at: null,
      registration_close_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const beforeOpen = await callAs("get", `/api/events/discovery/${beforeOpenId}`);
    const afterClose = await callAs("get", `/api/events/discovery/${afterCloseId}`);

    expect(beforeOpen.status).toBe(200);
    expect(afterClose.status).toBe(200);
    expect(beforeOpen.body.event.registrationAvailability).toBe("CLOSED");
    expect(afterClose.body.event.registrationAvailability).toBe("CLOSED");
  });

  test("should_report_full_when_registered_count_reaches_capacity", async () => {
    const eventId = await insertEvent("registration-full", { registration_capacity: 1 });
    await insertRegistration(eventId, "attendee", "REGISTERED");
    const response = await callAs("get", `/api/events/discovery/${eventId}`);
    const listItem = (await listAllDiscoveryEvents()).find((event) => event.eventId === eventId);

    expect(response.status).toBe(200);
    expect(response.body.event.registrationAvailability).toBe("FULL_WAITLIST");
    expect(listItem.registrationAvailability).toBe("FULL_WAITLIST");
  });

  test("should_not_count_waitlisted_or_withdrawn_registrations_toward_capacity", async () => {
    const eventId = await insertEvent("registration-status-count", { registration_capacity: 2 });
    await insertRegistration(eventId, "attendee", "REGISTERED");
    await insertRegistration(eventId, "deactivatable", "WAITLISTED");
    await insertRegistration(eventId, "inactive", "WITHDRAWN");
    const response = await callAs("get", `/api/events/discovery/${eventId}`);
    const listItem = (await listAllDiscoveryEvents()).find((event) => event.eventId === eventId);

    expect(response.status).toBe(200);
    expect(response.body.event.registrationAvailability).toBe("OPEN");
    expect(listItem.registrationAvailability).toBe("OPEN");
  });

  test.skip("[Q6][SPM-126] should_list_published_preparation_events_and_follow_master_registration_rules", async () => {
    // PROVISIONAL Q6: add PREPARATION once the event_status migration includes it.
    const { data, error } = await supabase.from("event").insert({
      title: `spm34-${runId}-preparation`,
      description: "Published preparation event",
      purpose: "Internal preparation notes",
      organiser_id: fixtures.accounts.organiserA.userId,
      coordinator_id: fixtures.accounts.coordinator.userId,
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

    const listResponse = await callAs("get", "/api/events/discovery");
    const detailResponse = await callAs("get", `/api/events/discovery/${data.event_id}`);
    expect(listResponse.status).toBe(200);
    expect(detailResponse.status).toBe(200);
    expect(listResponse.body.events.some((event) => event.eventId === data.event_id)).toBe(true);
    expect(detailResponse.body.event.registrationAvailability).toBe("OPEN");
  });
});