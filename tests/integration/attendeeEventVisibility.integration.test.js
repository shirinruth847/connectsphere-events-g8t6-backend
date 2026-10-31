// SPM-44 live integration tests: which events an attendee can see on the
// Attendee Event Dashboard (GET /api/events/discovery) and through direct detail
// access. Visibility follows Jira SPM-44 and Master 1.5 section 5.3 and D02:
// published events whose status is exactly CONFIRMED and that have not ended;
// PREPARATION is hidden. State changes are made directly
// on this run's fixture events, standing in for the lifecycle transitions.
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { encodeDiscoveryCursor } = require("../../model/eventModel");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { bookPrimaryVenue } = require("../fixtures/registrationFixtures");
const {
  newRunId,
  createAuthFixtures,
  cleanupAuthFixtures,
  recordFixtureIds,
} = require("../fixtures/authFixtures");

jest.setTimeout(120000);

const ALL_EVENT_STATES = [
  "DRAFT", "SUBMITTED", "UNDER_REVIEW", "AWAITING_CLARIFICATION", "APPROVED", "PLANNING",
  "SAFETY_REVIEW", "CONFIRMED", "PREPARATION", "COMPLETED", "CANCELLED", "REJECTED",
];
const DISCOVERABLE_STATES = ["CONFIRMED"];
const CARD_FIELDS = [
  "description", "endDatetime", "eventId", "location", "organisationName",
  "registrationAvailability", "startDatetime", "title",
];
const NOT_FOUND = { error: "Event request not found.", code: "EVENT_NOT_FOUND" };

const runId = newRunId();
let fixtures;
let attendeeSession;

const asAttendee = (path) => request(app).get(path).set("Authorization", `Bearer ${attendeeSession.access_token}`);

const listDiscoveryIds = async () => {
  const ids = new Map();
  let cursor = null;
  do {
    const res = await asAttendee(`/api/events/discovery?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
    if (res.status !== 200) throw new Error(`Discovery list failed with ${res.status}`);
    for (const event of res.body.events) ids.set(event.eventId, event);
    cursor = res.body.nextCursor;
  } while (cursor);
  return ids;
};

// Each fixture gets its own slot: the database rejects overlapping events for
// one coordinator (COORDINATOR_CONFLICT).
let slot = 0;

const insertEvent = async (suffix, overrides = {}) => {
  slot += 1;
  const startsAt = Date.now() + (6 + slot * 4) * 60 * 60 * 1000;
  const { data, error } = await supabase.from("event").insert({
    title: `spm44-${runId}-${suffix}`,
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
    ...overrides,
  }).select("event_id").single();
  if (error) throw new Error(`Fixture event insert failed: ${error.message}`);
  recordFixtureIds(runId, "eventIds", [data.event_id]);
  return data.event_id;
};

// SPM-134 (Master 5.6): availability needs a registration period and a primary
// venue, whose capacity limits registration. Each event gets its own venue.
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

const insertRow = async (table, row, idColumn, manifestList) => {
  const { data, error } = await supabase.from(table).insert(row).select(idColumn).single();
  if (error) throw new Error(`Fixture ${table} insert failed: ${error.message}`);
  recordFixtureIds(runId, manifestList, [data[idColumn]]);
  return data[idColumn];
};

const insertSecondVenueRoom = async () => {
  const venueId = await insertRow(
    "venue",
    { name: `spm44-${runId} Annex`, address: `spm44-${runId} 9 Annex Road`, max_capacity: 120 },
    "venue_id",
    "venueIds",
  );
  return insertRow("room", { venue_id: venueId, layout_type: "THEATRE", capacity: 120 }, "room_id", "roomIds");
};

// A booking lies within its event (Master 6.3, enforced by a trigger since
// SPM-179), so each fixture booking uses its event's own times.
const insertBooking = async (eventId, roomId, status) => {
  const { data: event, error } = await supabase.from("event").select("start_datetime,end_datetime").eq("event_id", eventId).single();
  if (error) throw new Error(`Fixture event read failed: ${error.message}`);
  return insertRow(
    "venue_booking",
    {
      event_id: eventId,
      room_id: roomId,
      requested_by: fixtures.accounts.coordinator.userId,
      start_datetime: event.start_datetime,
      end_datetime: event.end_datetime,
      status,
    },
    "booking_id",
    "bookingIds",
  );
};

const insertRegistration = async (eventId, accountKey, status) =>
  insertRow(
    "registration",
    { event_id: eventId, attendee_id: fixtures.accounts[accountKey].userId, registration_status: status },
    "registration_id",
    "registrationIds",
  );

// Only ever changes an event this run created.
const setStatus = async (eventId, status) => {
  const { error } = await supabase.from("event").update({ status }).eq("event_id", eventId).like("title", `spm44-${runId}-%`);
  if (error) throw new Error(`Fixture status update failed: ${error.message}`);
};

beforeAll(async () => {
  fixtures = await createAuthFixtures(runId);
  const { session, error } = await signInWithPassword(fixtures.accounts.attendee.email, fixtures.accounts.attendee.password);
  if (error || !session) throw new Error(`Attendee sign-in failed: ${error ? error.code : "no session"}`);
  attendeeSession = session;
});

afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("[SPM-44] Attendee Event Dashboard listing", () => {
  test("[TC-EVENT-001/002/003/009] should_list_only_published_confirmed_events_as_separate_cards_when_states_are_mixed", async () => {
    const byState = {};
    for (const status of ALL_EVENT_STATES) {
      byState[status] = await insertEvent(`state-${status.toLowerCase()}`, { status });
    }
    const unpublishedConfirmed = await insertEvent("unpublished-confirmed", { is_published: false });

    const listed = await listDiscoveryIds();

    for (const status of ALL_EVENT_STATES) {
      expect({ status, listed: listed.has(byState[status]) }).toEqual({ status, listed: DISCOVERABLE_STATES.includes(status) });
    }
    expect(listed.has(unpublishedConfirmed)).toBe(false);
  });

  test("[TC-EVENT-004] should_return_attendee_facing_card_fields_and_nothing_internal_when_listing", async () => {
    const eventId = await insertRegistrableEvent("card-fields");

    const card = (await listDiscoveryIds()).get(eventId);

    expect(Object.keys(card).sort()).toEqual(CARD_FIELDS);
    expect(card).toEqual(expect.objectContaining({
      title: `spm44-${runId}-card-fields`,
      description: "Public description for card-fields",
      registrationAvailability: "OPEN",
    }));
    expect(JSON.stringify(card)).not.toMatch(/Internal planning|Internal accessibility|organiser_?id|coordinator/i);
  });

  test("[TC-EVENT-004] should_return_detail_with_card_fields_plus_registration_window_and_nothing_internal", async () => {
    const opensAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const eventId = await insertEvent("detail-fields", { registration_open_at: opensAt });

    const res = await asAttendee(`/api/events/discovery/${eventId}`);

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.event).sort()).toEqual([...CARD_FIELDS, "registrationCloseAt", "registrationOpenAt"].sort());
    expect(new Date(res.body.event.registrationOpenAt).toISOString()).toBe(opensAt);
    expect(JSON.stringify(res.body)).not.toMatch(/Internal planning|Internal accessibility/);
  });

  test("[TC-EVENT-004] should_show_the_single_approved_venue_as_location_when_listing", async () => {
    const eventId = await insertEvent("location-approved");
    await insertBooking(eventId, fixtures.venue.roomId, "APPROVED");

    const card = (await listDiscoveryIds()).get(eventId);

    expect(card.location).toMatch(new RegExp(`^spm32-${runId} Hall, spm32-${runId} 1 Test Road$`));
  });

  test.each([
    ["only a pending booking", ["PENDING"]],
    ["two approved venues and no primary flag", ["APPROVED", "APPROVED_SECOND_VENUE"]],
  ])("[SPM-44 Master 5.3] should_hide_the_location_when_the_event_has_%s", async (_label, bookings) => {
    const eventId = await insertEvent(`location-${bookings.length}-${bookings[0].toLowerCase()}`);
    for (const booking of bookings) {
      const roomId = booking === "APPROVED_SECOND_VENUE" ? await insertSecondVenueRoom() : fixtures.venue.roomId;
      await insertBooking(eventId, roomId, booking === "APPROVED_SECOND_VENUE" ? "APPROVED" : booking);
    }

    const card = (await listDiscoveryIds()).get(eventId);

    expect(card).toBeDefined();
    expect(card.location).toBeNull();
  });

  test("[SPM-44 AC3] should_keep_a_full_confirmed_event_listed_as_full_waitlist", async () => {
    const eventId = await insertRegistrableEvent("registration-full", { registration_capacity: 1 });
    await insertRegistration(eventId, "deactivatable", "REGISTERED");

    const card = (await listDiscoveryIds()).get(eventId);

    expect(card).toBeDefined();
    expect(card.registrationAvailability).toBe("FULL_WAITLIST");
  });

  test.each([
    // The start and end times and the primary venue decide availability; the
    // enabled flag does not (SPM-134 final rule, Master 5.6).
    ["registration disabled", { is_registration_enabled: false, registration_capacity: null }, "OPEN"],
    ["registration window closed", { registration_close_at: new Date(Date.now() - 60 * 1000).toISOString() }, "CLOSED"],
    ["registration not yet open", { registration_open_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }, "NOT_YET_OPEN"],
  ])("[SPM-44] should_keep_a_confirmed_event_listed_when_%s", async (_label, overrides, availability) => {
    const eventId = await insertRegistrableEvent(`registration-${availability.toLowerCase()}-${Object.keys(overrides)[0]}`, overrides);

    const card = (await listDiscoveryIds()).get(eventId);

    expect(card).toBeDefined();
    expect(card.registrationAvailability).toBe(availability);
  });
});

describe("[SPM-44 Master 5.3] publication and timing boundaries", () => {
  test("[SPM-44] should_hide_a_published_event_in_preparation_from_list_and_detail", async () => {
    const eventId = await insertEvent("published-preparation", { status: "PREPARATION", is_published: true });

    expect((await listDiscoveryIds()).has(eventId)).toBe(false);
    expect((await asAttendee(`/api/events/discovery/${eventId}`)).status).toBe(404);
  });

  test("should_list_an_event_that_has_started_but_not_ended", async () => {
    // Starts after the "ended" fixture's end so the two never overlap for the coordinator.
    const eventId = await insertEvent("in-progress", {
      start_datetime: new Date(Date.now() - 30 * 1000).toISOString(),
      end_datetime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    expect((await listDiscoveryIds()).has(eventId)).toBe(true);
  });

  test("should_hide_an_event_from_list_and_detail_once_it_has_ended", async () => {
    const eventId = await insertEvent("ended", {
      start_datetime: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      end_datetime: new Date(Date.now() - 60 * 1000).toISOString(),
    });

    expect((await listDiscoveryIds()).has(eventId)).toBe(false);
    expect((await asAttendee(`/api/events/discovery/${eventId}`)).status).toBe(404);
  });

  test("should_hide_an_event_after_it_is_unpublished", async () => {
    const eventId = await insertEvent("unpublished-later");
    expect((await listDiscoveryIds()).has(eventId)).toBe(true);

    const { error } = await supabase.from("event").update({ is_published: false }).eq("event_id", eventId).like("title", `spm44-${runId}-%`);
    if (error) throw new Error(`Fixture unpublish failed: ${error.message}`);

    expect((await listDiscoveryIds()).has(eventId)).toBe(false);
  });
});

describe("[TC-EVENT-007/AC6] empty result", () => {
  test("should_return_200_with_an_empty_list_and_null_cursor_after_the_last_eligible_event", async () => {
    const beyondEveryEvent = encodeDiscoveryCursor({ start_datetime: "9999-12-31T00:00:00+00:00", event_id: 2147483647 });

    const res = await asAttendee(`/api/events/discovery?cursor=${beyondEveryEvent}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], nextCursor: null });
  });
});

describe("[SPM-44] lifecycle changes reach the dashboard on the next retrieval", () => {

  test("[TC-EVENT-005] should_list_an_event_and_open_its_detail_after_it_becomes_confirmed", async () => {
    const eventId = await insertEvent("becomes-confirmed", { status: "SAFETY_REVIEW" });
    expect((await listDiscoveryIds()).has(eventId)).toBe(false);
    expect((await asAttendee(`/api/events/discovery/${eventId}`)).status).toBe(404);

    await setStatus(eventId, "CONFIRMED");

    expect((await listDiscoveryIds()).has(eventId)).toBe(true);
    expect((await asAttendee(`/api/events/discovery/${eventId}`)).status).toBe(200);
  });

  test.each(["PREPARATION", "PLANNING", "CANCELLED", "COMPLETED"])(
    "[TC-EVENT-006] should_remove_an_event_from_list_and_detail_after_it_moves_to_%s",
    async (status) => {
      const eventId = await insertEvent(`leaves-confirmed-${status.toLowerCase()}`);
      expect((await listDiscoveryIds()).has(eventId)).toBe(true);

      await setStatus(eventId, status);
      const detail = await asAttendee(`/api/events/discovery/${eventId}`);

      expect((await listDiscoveryIds()).has(eventId)).toBe(false);
      expect(detail.status).toBe(404);
      expect(detail.body).toEqual(NOT_FOUND);
    },
  );
});

describe("[SPM-44 AC2] direct detail access", () => {
  test.each(ALL_EVENT_STATES.filter((status) => !DISCOVERABLE_STATES.includes(status)))(
    "should_return_404_from_discovery_detail_when_event_is_%s",
    async (status) => {
      const eventId = await insertEvent(`detail-${status.toLowerCase()}`, { status });

      const res = await asAttendee(`/api/events/discovery/${eventId}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    },
  );

  test("[SPM-44] should_return_403_to_a_signed_in_organiser_on_both_discovery_routes", async () => {
    const eventId = await insertEvent("organiser-denied");
    const { session } = await signInWithPassword(fixtures.accounts.organiserA.email, fixtures.accounts.organiserA.password);

    const list = await request(app).get("/api/events/discovery").set("Authorization", `Bearer ${session.access_token}`);
    const detail = await request(app).get(`/api/events/discovery/${eventId}`).set("Authorization", `Bearer ${session.access_token}`);

    expect(list.status).toBe(403);
    expect(detail.status).toBe(403);
  });

  test("should_return_the_same_404_from_the_organiser_event_route_for_visible_and_hidden_events", async () => {
    const visibleId = await insertEvent("generic-route-visible");
    const hiddenId = await insertEvent("generic-route-hidden", { status: "PLANNING" });

    const visible = await asAttendee(`/api/events/${visibleId}`);
    const hidden = await asAttendee(`/api/events/${hiddenId}`);

    expect(visible.status).toBe(404);
    expect(hidden.status).toBe(404);
    expect(visible.body).toEqual(hidden.body);
    expect(JSON.stringify(hidden.body)).not.toContain("Internal planning");
  });
});
