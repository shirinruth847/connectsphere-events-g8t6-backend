// SPM-134 live integration tests: real Express routes, middleware, Supabase
// Auth and the shared development database from .env. Nothing is mocked.
// Users sign in with Supabase Auth as the browser does. Fixtures are synthetic
// and namespaced by run ID; every event and registration is in the manifest.
// Registering writes an append-only activity entry, so cleanup keeps those
// attendee profiles deactivated (README, Testing) unless TEST_DATABASE_URL is set.
const request = require("supertest");
const app = require("../../server");
const supabase = require("../../config/supabase");
const { signInWithPassword } = require("../fixtures/browserAuthClient");
const { newRunId, cleanupAuthFixtures, recordFixtureIds } = require("../fixtures/authFixtures");
const { createRegistrationFixtures, bookPrimaryVenue } = require("../fixtures/registrationFixtures");

jest.setTimeout(300000);

const runId = newRunId();
const NON_ATTENDEES = ["organiserA", "coordinator", "coordinatorLead", "venueStaff", "techSupport", "safetyOfficer"];
const RACE_ROUNDS = 3;
const DAY = 24 * 60 * 60 * 1000;

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
const answers = (dietaryRestrictions = null, accessibilityRequirements = null) => ({ dietaryRestrictions, accessibilityRequirements });
const registerAs = async (key, eventId, body = answers(), headers = {}) => {
  const req = request(app).post(`/api/registrations/mine/${eventId}`).set("Authorization", await bearer(key));
  for (const [name, value] of Object.entries(headers)) req.set(name, value);
  return req.send(body);
};

// Each event gets its own day, so fixture events never share a time slot, a
// registration period that started yesterday and ends the day before the
// event, and its own primary venue (venueCapacity null leaves it without one).
const insertEvent = async (overrides = {}, { venueCapacity = 50 } = {}) => {
  eventOffset += 1;
  const startsAt = Date.now() + (10 + eventOffset) * DAY;
  const { data, error } = await supabase.from("event").insert({
    title: `spm134-${runId}-event-${eventOffset}`,
    description: "Synthetic registration event",
    organiser_id: fixtures.accounts.organiserA.userId,
    coordinator_id: null,
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

const insertRegistration = async (eventId, accountKey, status) => {
  const { data, error } = await supabase.from("registration").insert({
    event_id: eventId,
    attendee_id: fixtures.accounts[accountKey].userId,
    registration_status: status,
  }).select("registration_id").single();
  if (error) throw new Error(`Fixture registration insert failed: ${error.message}`);
  recordFixtureIds(runId, "registrationIds", [data.registration_id]);
  return data.registration_id;
};

const recordRegistrations = (responses) =>
  recordFixtureIds(runId, "registrationIds", responses.filter((res) => res.status === 201).map((res) => res.body.registration.registrationId));

const registrationsFor = async (eventId) => {
  const { data, error } = await supabase
    .from("registration")
    .select("registration_id, attendee_id, registration_status, dietary_restrictions, accessibility_requirements")
    .eq("event_id", eventId)
    .order("registration_id");
  if (error) throw error;
  return data;
};

const confirmationsFor = async (eventId) => {
  const { data, error } = await supabase
    .from("notification")
    .select("type, title, notification_recipient(recipient_id)")
    .eq("event_id", eventId);
  if (error) throw error;
  return data.map((row) => ({ type: row.type, recipients: row.notification_recipient.map((r) => r.recipient_id) }));
};

const activityFor = async (registrationIds) => {
  if (!registrationIds.length) return [];
  const { data, error } = await supabase
    .from("activity_log")
    .select("user_id, action, audience, details")
    .eq("entity_name", "registration")
    .in("entity_id", registrationIds);
  if (error) throw error;
  return data;
};

// Registration activity written by this run's attendees. Tests in this file run
// one at a time, so a change in the count belongs to the test that made it.
const ATTENDEE_KEYS = ["attendee", "deactivatable", "racer"];
const registrationActivityCount = async () => {
  const { count, error } = await supabase
    .from("activity_log")
    .select("log_id", { count: "exact", head: true })
    .eq("entity_name", "registration")
    .in("user_id", ATTENDEE_KEYS.map((key) => fixtures.accounts[key].userId));
  if (error) throw error;
  return count;
};

// A refused attempt must leave no registration, confirmation or activity.
const expectNothingWritten = async (eventId, before) => {
  expect(await registrationsFor(eventId)).toEqual(before.registrations);
  expect(await confirmationsFor(eventId)).toEqual(before.confirmations);
  expect(await registrationActivityCount()).toBe(before.activity);
};
const snapshot = async (eventId) => ({
  registrations: await registrationsFor(eventId),
  confirmations: await confirmationsFor(eventId),
  activity: await registrationActivityCount(),
});

const discoveryAvailability = async (key, eventId) => {
  const res = await request(app).get(`/api/events/discovery/${eventId}`).set("Authorization", await bearer(key));
  expect(res.status).toBe(200);
  return res.body.event.registrationAvailability;
};

const updateEvent = async (eventId, changes) => {
  const { error } = await supabase.from("event").update(changes).eq("event_id", eventId).like("title", `spm134-${runId}-%`);
  if (error) throw error;
};

// Only what registration reads: the attendees, one account per other role, and
// the organiser's organisation for the confirmation. No venue or booking data.
beforeAll(async () => {
  fixtures = await createRegistrationFixtures(runId, [
    { key: "attendee", role: "ATTENDEE" },
    { key: "deactivatable", role: "ATTENDEE" },
    { key: "racer", role: "ATTENDEE" },
    { key: "organiserA", role: "ORGANISER", organisation: "A" },
    { key: "coordinator", role: "COORDINATOR" },
    { key: "coordinatorLead", role: "COORDINATOR_LEAD" },
    { key: "venueStaff", role: "VENUE_STAFF" },
    { key: "techSupport", role: "TECH_SUPPORT" },
    { key: "safetyOfficer", role: "SAFETY_OFFICER" },
    { key: "inactiveAttendee", role: "ATTENDEE" },
    { key: "myEvents", role: "ATTENDEE" },
    { key: "myEventsOther", role: "ATTENDEE" },
    { key: "myEventsEmpty", role: "ATTENDEE" },
  ]);
  // Trusted setup on this run's own row: an attendee whose account was deactivated.
  const { error } = await supabase
    .from("user")
    .update({ is_active: false })
    .eq("user_id", fixtures.accounts.inactiveAttendee.userId)
    .like("email", `spm32-${runId}-%`);
  if (error) throw error;
});

// Runs even when setup stopped part-way: the manifest lists what was created.
afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("[SPM-134] authentication and role", () => {
  test("[TC-REG-023] should_return_401_and_register_nothing_when_there_is_no_token", async () => {
    const eventId = await insertEvent();
    const res = await request(app).post(`/api/registrations/mine/${eventId}`).send(answers());
    expect(res.status).toBe(401);
    expect(await registrationsFor(eventId)).toEqual([]);
  });

  test.each(NON_ATTENDEES)("[SPM-134] should_return_403_and_register_nothing_when_%s_registers", async (key) => {
    const eventId = await insertEvent();
    const res = await registerAs(key, eventId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(await registrationsFor(eventId)).toEqual([]);
  });

  test("[TC-REG-005] should_register_only_the_signed_in_attendee_when_the_body_names_another_user", async () => {
    const eventId = await insertEvent();
    const forged = await registerAs("attendee", eventId, { ...answers(), userId: fixtures.accounts.racer.userId, attendeeId: 1 });
    expect(forged.status).toBe(400);
    expect(Object.keys(forged.body.fields).sort()).toEqual(["attendeeId", "userId"]);
    expect(await registrationsFor(eventId)).toEqual([]);
  });
});

describe("[SPM-134] successful registration", () => {
  test("[TC-REG-003] [TC-REG-006] [TC-REG-007] [TC-REG-011] [TC-REG-012] [TC-REG-013] [TC-REG-016] should_register_with_event_specific_answers_and_leave_the_saved_profile_unchanged", async () => {
    const savedProfile = await request(app)
      .put("/api/attendee-profile/mine")
      .set("Authorization", await bearer("attendee"))
      .send({ dietaryRestrictions: "Vegetarian", accessibilityRequirements: null, version: null });
    expect([201, 409]).toContain(savedProfile.status);

    // The form starts from the trusted user record and the saved profile.
    const defaults = (await request(app).get("/api/attendee-profile/mine").set("Authorization", await bearer("attendee"))).body.profile;
    expect(defaults).toMatchObject({ name: "spm32 attendee", email: fixtures.accounts.attendee.email, dietaryRestrictions: "Vegetarian" });

    const eventId = await insertEvent();
    const res = await registerAs("attendee", eventId, answers("Vegetarian, no peanuts", "Step-free access"));
    recordRegistrations([res]);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.registration).sort()).toEqual([
      "accessibilityRequirements", "confirmationNumber", "dietaryRestrictions", "event", "registeredAt", "registrationId", "status",
    ]);
    expect(Object.keys(res.body.registration.event).sort()).toEqual(["endDatetime", "eventId", "organisationName", "startDatetime", "title"]);
    expect(res.body.registration.event.startDatetime).toEqual(expect.any(String));
    expect(res.body.registration).toMatchObject({
      status: "REGISTERED",
      dietaryRestrictions: "Vegetarian, no peanuts",
      accessibilityRequirements: "Step-free access",
      event: { eventId, title: `spm134-${runId}-event-${eventOffset}`, organisationName: `spm32-${runId} Organisation A` },
    });
    const { registrationId, confirmationNumber } = res.body.registration;
    expect(confirmationNumber).toBe(`REG-${String(registrationId).padStart(6, "0")}`);

    expect(await registrationsFor(eventId)).toEqual([{
      registration_id: registrationId,
      attendee_id: fixtures.accounts.attendee.userId,
      registration_status: "REGISTERED",
      dietary_restrictions: "Vegetarian, no peanuts",
      accessibility_requirements: "Step-free access",
    }]);
    expect(await confirmationsFor(eventId)).toEqual([{ type: "REGISTRATION_CONFIRMED", recipients: [fixtures.accounts.attendee.userId] }]);
    const { data: notices, error: noticeError } = await supabase.from("notification").select("title, message").eq("event_id", eventId);
    if (noticeError) throw noticeError;
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toBe("Registration confirmed");
    expect(notices[0].message).toContain(`spm134-${runId}-event-${eventOffset}`);
    const activity = await activityFor([registrationId]);
    expect(activity).toEqual([{
      user_id: fixtures.accounts.attendee.userId,
      action: "REGISTRATION_CREATED",
      audience: "STAFF_ONLY",
      details: `Registered for event ${eventId}`,
    }]);

    const profileAfter = (await request(app).get("/api/attendee-profile/mine").set("Authorization", await bearer("attendee"))).body.profile;
    expect(profileAfter.dietaryRestrictions).toBe("Vegetarian");

    // A later profile edit never rewrites what was submitted for this event.
    await request(app)
      .put("/api/attendee-profile/mine")
      .set("Authorization", await bearer("attendee"))
      .send({ dietaryRestrictions: "Vegan", accessibilityRequirements: "Hearing loop", version: profileAfter.version });
    expect((await registrationsFor(eventId))[0]).toMatchObject({ dietary_restrictions: "Vegetarian, no peanuts", accessibility_requirements: "Step-free access" });

    // The attendee's own registered-event view now shows the place.
    const mine = await request(app).get(`/api/registrations/mine/${eventId}`).set("Authorization", await bearer("attendee"));
    expect(mine.status).toBe(200);
    expect(mine.body.myRegistration.status).toBe("REGISTERED");
  });

  test("[TC-REG-004] should_register_with_blank_answers_when_the_attendee_has_no_saved_profile", async () => {
    const eventId = await insertEvent();
    const res = await registerAs("racer", eventId, answers("", "  "));
    recordRegistrations([res]);
    expect(res.status).toBe(201);
    expect(res.body.registration).toMatchObject({ dietaryRestrictions: null, accessibilityRequirements: null });
  });

  test("[SPM-134] should_store_unicode_answers_unchanged_when_they_are_valid", async () => {
    const eventId = await insertEvent();
    const res = await registerAs("deactivatable", eventId, answers("素食 🌾, café — no peanuts", "Ramp ♿"));
    recordRegistrations([res]);
    expect(res.status).toBe(201);
    expect((await registrationsFor(eventId))[0]).toMatchObject({ dietary_restrictions: "素食 🌾, café — no peanuts", accessibility_requirements: "Ramp ♿" });
  });

  // Only CONFIRMED events take registrations, as only they are discoverable
  // (SPM-44); a confirmed event moved back to planning is hidden too.
  test.each([
    ["PREPARATION", false],
    ["PLANNING", false],
    ["PLANNING", true],
    ["SAFETY_REVIEW", true],
  ])(
    "[SPM-134] should_return_404_and_register_nothing_when_the_event_is_in_%s_previously_confirmed_%s",
    async (status, previouslyConfirmed) => {
      const eventId = await insertEvent({ status, previously_confirmed: previouslyConfirmed });
      const before = await snapshot(eventId);
      const res = await registerAs("racer", eventId);
      recordRegistrations([res]);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("EVENT_NOT_FOUND");
      await expectNothingWritten(eventId, before);
      expect(before.registrations).toEqual([]);
    }
  );

  test("[SPM-134] should_replay_the_confirmation_without_a_second_registration_when_the_same_key_is_retried", async () => {
    const eventId = await insertEvent();
    const key = { "Idempotency-Key": `spm134-${runId}-replay` };
    const first = await registerAs("deactivatable", eventId, answers("Halal"), key);
    const replay = await registerAs("deactivatable", eventId, answers("Halal"), key);
    recordRegistrations([first]);
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.registration).toEqual(first.body.registration);
    expect(await registrationsFor(eventId)).toHaveLength(1);
    expect(await confirmationsFor(eventId)).toHaveLength(1);
  });
});

describe("[SPM-134] duplicate registration", () => {
  test("[TC-REG-020] should_return_409_already_registered_and_write_nothing_when_the_attendee_registers_again", async () => {
    const eventId = await insertEvent();
    const first = await registerAs("racer", eventId, answers("Vegan"));
    recordRegistrations([first]);
    const before = await snapshot(eventId);
    const again = await registerAs("racer", eventId, answers("Halal"));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_REGISTERED");
    await expectNothingWritten(eventId, before);
  });

  test.each(Array.from({ length: RACE_ROUNDS }, (_, round) => [round + 1]))(
    "[TC-REG-020] should_create_exactly_one_registration_when_the_same_attendee_registers_in_parallel_round_%i", async () => {
    const eventId = await insertEvent();
    await signIn("deactivatable");
    const results = await Promise.all([1, 2, 3].map(() => registerAs("deactivatable", eventId)));
    recordRegistrations(results);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409, 409]);
    expect(results.filter((res) => res.status === 409).every((res) => res.body.code === "ALREADY_REGISTERED")).toBe(true);
    expect(await registrationsFor(eventId)).toHaveLength(1);
    expect(await confirmationsFor(eventId)).toHaveLength(1);
  });

  test("[SPM-134] should_return_409_already_waitlisted_when_the_attendee_is_on_the_waitlist", async () => {
    const eventId = await insertEvent();
    await insertRegistration(eventId, "attendee", "WAITLISTED");
    const res = await registerAs("attendee", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_WAITLISTED");
  });
});

describe("[SPM-134] capacity", () => {
  test("[TC-REG-017] should_return_409_registration_full_without_a_waitlist_row_when_capacity_is_reached", async () => {
    const eventId = await insertEvent({ registration_capacity: 1 });
    await insertRegistration(eventId, "deactivatable", "REGISTERED");
    const before = await snapshot(eventId);
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_FULL");
    await expectNothingWritten(eventId, before);
    expect((await registrationsFor(eventId)).filter((row) => row.registration_status === "WAITLISTED")).toEqual([]);
    expect(await discoveryAvailability("racer", eventId)).toBe("FULL_WAITLIST");
  });

  test.each(Array.from({ length: RACE_ROUNDS }, (_, round) => [round + 1]))(
    "[TC-REG-021] should_give_the_last_place_to_exactly_one_attendee_when_two_register_in_parallel_round_%i",
    async () => {
      const eventId = await insertEvent({ registration_capacity: 2 });
      await insertRegistration(eventId, "attendee", "REGISTERED");
      await Promise.all([signIn("racer"), signIn("deactivatable")]);
      const results = await Promise.all([registerAs("racer", eventId), registerAs("deactivatable", eventId)]);
      recordRegistrations(results);
      expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      expect(results.find((res) => res.status === 409).body.code).toBe("REGISTRATION_FULL");
      const registered = (await registrationsFor(eventId)).filter((row) => row.registration_status === "REGISTERED");
      expect(registered).toHaveLength(2);
      expect(await confirmationsFor(eventId)).toHaveLength(1);

      // Discovery now shows the event as full.
      const detail = await request(app).get(`/api/events/discovery/${eventId}`).set("Authorization", await bearer("attendee"));
      expect(detail.status).toBe(200);
      expect(detail.body.event.registrationAvailability).toBe("FULL_WAITLIST");
    }
  );
});

// Final rule (team agreement of 30 October 2026, Master 5.6): a CONFIRMED,
// attendee-visible event takes registrations from registration_open_at until
// registration_close_at, subject to its primary venue's capacity. The enabled
// flag is not a gate. Discovery shows the state registration enforces.
describe("[SPM-134] registration period, venue capacity and the enabled flag", () => {
  test("[TC-REG-011] should_register_during_the_registration_period_when_places_remain", async () => {
    const eventId = await insertEvent({ registration_capacity: 2 });
    expect(await discoveryAvailability("racer", eventId)).toBe("OPEN");
    const res = await registerAs("racer", eventId);
    recordRegistrations([res]);
    expect(res.status).toBe(201);
    expect(res.body.registration.status).toBe("REGISTERED");
  });

  test("[SPM-134] should_return_409_registration_not_yet_open_and_write_nothing_before_the_start_time", async () => {
    const eventId = await insertEvent({ registration_open_at: new Date(Date.now() + DAY).toISOString() });
    expect(await discoveryAvailability("racer", eventId)).toBe("NOT_YET_OPEN");
    const before = await snapshot(eventId);
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_NOT_YET_OPEN");
    expect(res.body.registration).toBeUndefined();
    await expectNothingWritten(eventId, before);
  });

  test("[TC-REG-018] should_return_409_registration_closed_and_write_nothing_when_the_end_time_has_passed", async () => {
    const eventId = await insertEvent({
      registration_open_at: new Date(Date.now() - 2 * DAY).toISOString(),
      registration_close_at: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const before = await snapshot(eventId);
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_CLOSED");
    await expectNothingWritten(eventId, before);
    expect(await discoveryAvailability("racer", eventId)).toBe("CLOSED");
  });

  test("[SPM-134] should_return_registration_closed_not_full_when_the_end_time_has_passed_on_a_full_event", async () => {
    const eventId = await insertEvent({ registration_capacity: 1, registration_close_at: new Date(Date.now() - 60 * 1000).toISOString() });
    await insertRegistration(eventId, "deactivatable", "REGISTERED");
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_CLOSED");
    expect(await discoveryAvailability("racer", eventId)).toBe("CLOSED");
  });

  test("[TC-REG-017] should_stop_direct_registration_at_the_primary_venue_capacity", async () => {
    // No organiser cap (allowed only with the flag off), so the venue alone limits.
    const eventId = await insertEvent({ is_registration_enabled: false, registration_capacity: null }, { venueCapacity: 2 });
    await insertRegistration(eventId, "attendee", "REGISTERED");
    expect(await discoveryAvailability("racer", eventId)).toBe("OPEN");
    const last = await registerAs("racer", eventId);
    recordRegistrations([last]);
    expect(last.status).toBe(201);
    expect(await discoveryAvailability("racer", eventId)).toBe("FULL_WAITLIST");

    const before = await snapshot(eventId);
    const full = await registerAs("deactivatable", eventId);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("REGISTRATION_FULL");
    await expectNothingWritten(eventId, before);
    expect((await registrationsFor(eventId)).filter((row) => row.registration_status === "WAITLISTED")).toEqual([]);
  });

  test("[SPM-134] should_stop_at_the_venue_capacity_when_the_organiser_cap_is_higher", async () => {
    const eventId = await insertEvent({ registration_capacity: 10 }, { venueCapacity: 1 });
    const first = await registerAs("racer", eventId);
    recordRegistrations([first]);
    expect(first.status).toBe(201);
    const second = await registerAs("deactivatable", eventId);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("REGISTRATION_FULL");
  });

  test("[SPM-134] should_register_and_still_enforce_capacity_when_registration_enabled_is_false", async () => {
    const eventId = await insertEvent({ is_registration_enabled: false, registration_capacity: 1 });
    expect(await discoveryAvailability("racer", eventId)).toBe("OPEN");
    const res = await registerAs("racer", eventId);
    recordRegistrations([res]);
    expect(res.status).toBe(201);
    expect(await registrationsFor(eventId)).toHaveLength(1);
    expect(await confirmationsFor(eventId)).toHaveLength(1);

    expect(await discoveryAvailability("racer", eventId)).toBe("FULL_WAITLIST");
    const before = await snapshot(eventId);
    const full = await registerAs("deactivatable", eventId);
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("REGISTRATION_FULL");
    await expectNothingWritten(eventId, before);
  });

  // Missing configuration never means "always open" or "unlimited".
  test.each([
    ["there_is_no_primary_venue", {}, { venueCapacity: null }],
    ["there_is_no_registration_start_time", { registration_open_at: null }, {}],
    ["there_is_no_registration_end_time", { registration_close_at: null }, {}],
  ])("[SPM-134] should_return_409_registration_unavailable_and_write_nothing_when_%s", async (_label, overrides, options) => {
    const eventId = await insertEvent(overrides, options);
    expect(await discoveryAvailability("racer", eventId)).toBe("UNAVAILABLE");
    const before = await snapshot(eventId);
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_UNAVAILABLE");
    await expectNothingWritten(eventId, before);
  });

  test("[SPM-134] should_return_404_when_the_event_is_unpublished_closed_out_or_missing", async () => {
    const hidden = [await insertEvent({ is_published: false }), await insertEvent({ status: "COMPLETED" })];
    for (const eventId of hidden) {
      const res = await registerAs("racer", eventId);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("EVENT_NOT_FOUND");
      expect(await registrationsFor(eventId)).toEqual([]);
    }
    expect((await registerAs("racer", 2147483000)).status).toBe(404);
  });
});

describe("[SPM-134] validation", () => {
  test.each([
    ["an_unknown_field", { ...answers(), responses: [] }],
    ["a_server_owned_field", { ...answers(), status: "REGISTERED", confirmationNumber: "REG-1", registrationCapacity: 999 }],
    ["a_missing_answer", { dietaryRestrictions: "Vegan" }],
    ["over_long_text", answers("x".repeat(1001))],
    ["a_nul_character", answers("Vegan\u0000")],
  ])("[TC-REG-009] [TC-REG-010] should_return_400_and_register_nothing_when_the_body_has_%s", async (label, body) => {
    const eventId = await insertEvent();
    const res = await registerAs("racer", eventId, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(await registrationsFor(eventId)).toEqual([]);
  });
});

// Same header and signature as a real token, with a payload claiming more.
const tamperedToken = (accessToken) => {
  const [header, payload, signature] = accessToken.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const forged = { ...claims, sub: "00000000-0000-0000-0000-000000000000", role: "service_role", user_role: "ATTENDEE" };
  return [header, Buffer.from(JSON.stringify(forged)).toString("base64url"), signature].join(".");
};

describe("[SPM-134] authentication edge cases (AC18)", () => {
  test("[TC-REG-023] should_return_401_and_register_nothing_when_the_token_is_malformed_or_tampered", async () => {
    const eventId = await insertEvent();
    const session = await signIn("attendee");
    const malformed = await request(app).post(`/api/registrations/mine/${eventId}`).set("Authorization", "Bearer not-a-jwt").send(answers());
    const tampered = await request(app)
      .post(`/api/registrations/mine/${eventId}`)
      .set("Authorization", `Bearer ${tamperedToken(session.access_token)}`)
      .send(answers());
    expect([malformed.status, tampered.status]).toEqual([401, 401]);
    expect(await registrationsFor(eventId)).toEqual([]);
  });

  test("[TC-REG-023] should_return_401_and_register_nothing_when_the_attendee_account_is_inactive", async () => {
    const eventId = await insertEvent();
    const res = await registerAs("inactiveAttendee", eventId);
    expect(res.status).toBe(401);
    expect(await registrationsFor(eventId)).toEqual([]);
  });
});

describe("[SPM-134] form starting values (AC3, AC5)", () => {
  test("[TC-REG-003] should_offer_trusted_name_email_and_saved_preferences_when_the_attendee_has_a_profile", async () => {
    const profile = await request(app).put("/api/attendee-profile/mine").set("Authorization", await bearer("deactivatable"))
      .send({ dietaryRestrictions: "Halal", accessibilityRequirements: "Ramp access", version: null });
    expect([201, 409]).toContain(profile.status);
    const res = await request(app).get("/api/attendee-profile/mine").set("Authorization", await bearer("deactivatable"));
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({
      name: "spm32 deactivatable",
      email: fixtures.accounts.deactivatable.email,
      dietaryRestrictions: "Halal",
      accessibilityRequirements: "Ramp access",
    });
  });

  test("[TC-REG-004] should_offer_blank_preferences_when_the_attendee_has_no_saved_profile", async () => {
    const res = await request(app).get("/api/attendee-profile/mine").set("Authorization", await bearer("racer"));
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({
      name: "spm32 racer",
      email: fixtures.accounts.racer.email,
      attendeeId: null,
      dietaryRestrictions: null,
      accessibilityRequirements: null,
    });
  });
});

describe("[SPM-134] registered state after registration (AC10)", () => {
  test("[TC-REG-014] [TC-REG-015] should_show_the_registered_place_in_the_attendee_views_when_registration_succeeds", async () => {
    const eventId = await insertEvent();
    const res = await registerAs("racer", eventId);
    recordRegistrations([res]);
    expect(res.status).toBe(201);

    const own = await request(app).get(`/api/registrations/mine/${eventId}`).set("Authorization", await bearer("racer"));
    expect(own.status).toBe(200);
    expect(own.body.myRegistration.status).toBe("REGISTERED");

    const list = await request(app).get("/api/registrations/mine?limit=100").set("Authorization", await bearer("racer"));
    expect(list.status).toBe(200);
    expect(list.body.registrations.find((row) => row.event.event_id === eventId)).toMatchObject({ registration_status: "REGISTERED" });

    // Another attendee holds no place on the same event.
    expect((await request(app).get(`/api/registrations/mine/${eventId}`).set("Authorization", await bearer("deactivatable"))).status).toBe(404);
  });
});

describe("[SPM-134] availability changes after the form opens (AC16)", () => {
  test("[TC-REG-021] should_return_409_registration_full_when_the_last_place_is_taken_before_submission", async () => {
    const eventId = await insertEvent({ registration_capacity: 1 });
    expect(await discoveryAvailability("racer", eventId)).toBe("OPEN");
    const taken = await registerAs("deactivatable", eventId);
    recordRegistrations([taken]);
    expect(taken.status).toBe(201);
    const before = await snapshot(eventId);
    const late = await registerAs("racer", eventId, answers("Vegan"));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("REGISTRATION_FULL");
    expect(late.body.registration).toBeUndefined();
    await expectNothingWritten(eventId, before);
  });

  test("[TC-REG-021] should_return_409_registration_closed_when_the_window_closes_before_submission", async () => {
    const eventId = await insertEvent();
    expect(await discoveryAvailability("racer", eventId)).toBe("OPEN");
    await updateEvent(eventId, { registration_close_at: new Date(Date.now() - 1000).toISOString() });
    const before = await snapshot(eventId);
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_CLOSED");
    await expectNothingWritten(eventId, before);
  });

  test.each([
    ["unpublished", { is_published: false }],
    ["moved_back_to_planning", { status: "PLANNING", previously_confirmed: true }],
  ])("[TC-REG-021] should_return_404_when_the_event_is_%s_before_submission", async (label, changes) => {
    const eventId = await insertEvent();
    expect(await discoveryAvailability("racer", eventId)).toBe("OPEN");
    await updateEvent(eventId, changes);
    const before = await snapshot(eventId);
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EVENT_NOT_FOUND");
    await expectNothingWritten(eventId, before);
  });
});

describe("[SPM-134] idempotent retries (Master 6.3)", () => {
  test("[SPM-134] should_return_409_idempotency_key_reused_and_write_nothing_when_a_key_is_reused_for_different_answers", async () => {
    const eventId = await insertEvent();
    const key = { "Idempotency-Key": `spm134-${runId}-reuse` };
    const first = await registerAs("racer", eventId, answers("Vegan"), key);
    recordRegistrations([first]);
    expect(first.status).toBe(201);
    const before = await snapshot(eventId);
    const reused = await registerAs("racer", eventId, answers("Halal"), key);
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    await expectNothingWritten(eventId, before);
  });

  test("[SPM-134] should_create_one_registration_and_one_notice_when_the_same_key_is_sent_in_parallel", async () => {
    const eventId = await insertEvent();
    const key = { "Idempotency-Key": `spm134-${runId}-parallel` };
    await signIn("deactivatable");
    const activityBefore = await registrationActivityCount();
    const results = await Promise.all([1, 2, 3].map(() => registerAs("deactivatable", eventId, answers("Halal"), key)));
    recordRegistrations(results);
    expect(results.map((res) => res.status)).toEqual([201, 201, 201]);
    expect(results.filter((res) => res.headers["idempotent-replayed"] === "true")).toHaveLength(2);
    expect(new Set(results.map((res) => res.body.registration.registrationId)).size).toBe(1);
    expect(await registrationsFor(eventId)).toHaveLength(1);
    expect(await confirmationsFor(eventId)).toHaveLength(1);
    expect(await registrationActivityCount()).toBe(activityBefore + 1);
  });
});

describe("[SPM-134] re-entry after withdrawal (Master 5.6, D05)", () => {
  test("[SPM-134] should_re_enter_the_same_record_with_a_new_confirmation_when_the_attendee_had_withdrawn", async () => {
    const eventId = await insertEvent();
    const registrationId = await insertRegistration(eventId, "racer", "WITHDRAWN");
    const activityBefore = await registrationActivityCount();
    const res = await registerAs("racer", eventId, answers("Kosher"));
    expect(res.status).toBe(201);
    expect(res.body.registration).toMatchObject({ registrationId, status: "REGISTERED", dietaryRestrictions: "Kosher" });
    expect(await registrationsFor(eventId)).toEqual([{
      registration_id: registrationId,
      attendee_id: fixtures.accounts.racer.userId,
      registration_status: "REGISTERED",
      dietary_restrictions: "Kosher",
      accessibility_requirements: null,
    }]);
    expect(await confirmationsFor(eventId)).toEqual([{ type: "REGISTRATION_CONFIRMED", recipients: [fixtures.accounts.racer.userId] }]);
    expect((await activityFor([registrationId])).map((row) => row.action)).toEqual(["REGISTRATION_REENTERED"]);
    expect(await registrationActivityCount()).toBe(activityBefore + 1);
  });
});


// Real API/independent-client regression. Runs only with the explicitly
// authorized hosted suite and its namespaced fixtures, never as a unit test.
test("[SPM-134] an event-lock wait across the deadline refuses registration without side effects", async () => {
  await signIn("racer");
  const eventId = await insertEvent();
  const { Client } = require("pg");
  if (!process.env.TEST_DATABASE_URL?.includes("rvwiflsedoujspmzfrbq")) throw new Error("Development test connection required");
  const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  let pending;
  try {
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query("SET LOCAL statement_timeout='15s'");
    await blocker.query("SELECT 1 FROM public.event WHERE event_id=$1 FOR UPDATE", [eventId]);
    await blocker.query("UPDATE public.event SET registration_close_at=clock_timestamp()+interval '5 seconds' WHERE event_id=$1", [eventId]);
    pending = registerAs("racer", eventId, answers("Synthetic deadline test"), {
      "Idempotency-Key": `spm134-${runId}-deadline-lock`,
    }).then(response => { recordRegistrations([response]); return response; });
    let blocked = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await blocker.query(`SELECT EXISTS(
        SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))
      ) AS blocked`);
      if (result.rows[0].blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(blocked).toBe(true);
    const timing = await blocker.query("SELECT clock_timestamp()<registration_close_at before_close FROM public.event WHERE event_id=$1", [eventId]);
    expect(timing.rows[0].before_close).toBe(true);
    // Database time controls this wait, independent of the test host clock.
    await blocker.query(`SELECT pg_sleep(GREATEST(0, extract(epoch FROM
      ((SELECT registration_close_at FROM public.event WHERE event_id=$1)-clock_timestamp())))+0.05)`, [eventId]);
    await blocker.query("COMMIT");
    const response = await pending;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("REGISTRATION_CLOSED");
    expect(await registrationsFor(eventId)).toHaveLength(0);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {});
    await blocker.end();
    if (pending) await pending;
  }
});

// SPM-141 My Events: the list and the event page reuse SPM-134, SPM-163 and
// SPM-147 state. Waitlist positions and offers come from the real join,
// withdraw and leave routes, so the database decides them.
describe("[SPM-141] My Events", () => {
  const places = {};
  const getAs = async (key, path) => request(app).get(path).set("Authorization", await bearer(key));
  const postAs = async (key, path, body = {}) => request(app).post(path).set("Authorization", await bearer(key)).send(body);
  const listAll = async (key, limit) => {
    const rows = [];
    let offset = 0;
    for (let page = 0; page < 20 && offset !== null; page += 1) {
      const res = await getAs(key, `/api/registrations/mine?limit=${limit}&offset=${offset}`);
      expect(res.status).toBe(200);
      rows.push(...res.body.registrations);
      offset = res.body.page.next_offset;
    }
    return rows;
  };
  const rowFor = (rows, eventId) => rows.find((row) => row.event.event_id === eventId);
  const joinAs = async (key, eventId) => {
    const res = await postAs(key, `/api/registrations/mine/${eventId}/waitlist`, answers());
    if (res.status === 201) recordFixtureIds(runId, "registrationIds", [res.body.registration.registrationId]);
    return res;
  };

  beforeAll(async () => {
    places.registered = await insertEvent();
    await insertRegistration(places.registered, "myEvents", "REGISTERED");
    places.laterRegistered = await insertEvent();
    await insertRegistration(places.laterRegistered, "myEvents", "REGISTERED");
    places.withdrawn = await insertEvent();
    await insertRegistration(places.withdrawn, "myEvents", "WITHDRAWN");
    places.cancelled = await insertEvent({ status: "CANCELLED" }, { venueCapacity: null });
    await insertRegistration(places.cancelled, "myEvents", "REGISTERED");
    places.othersOnly = await insertEvent();
    await insertRegistration(places.othersOnly, "myEventsOther", "REGISTERED");

    // Full one-place events: myEventsOther queues first on the queue event.
    places.queue = await insertEvent({ registration_capacity: 1 });
    await insertRegistration(places.queue, "racer", "REGISTERED");
    expect((await joinAs("myEventsOther", places.queue)).status).toBe(201);
    expect((await joinAs("myEvents", places.queue)).status).toBe(201);
    places.offer = await insertEvent({ registration_capacity: 1 });
    await insertRegistration(places.offer, "racer", "REGISTERED");
    expect((await joinAs("myEvents", places.offer)).status).toBe(201);
    expect((await postAs("racer", `/api/registrations/mine/${places.offer}/withdraw`)).status).toBe(200);
  });

  test("[TC-MYE-001][TC-MYE-005][TC-MYE-014] registered, waitlisted and offered places each come back once with event date, venue and status", async () => {
    const rows = await listAll("myEvents", 100);
    expect(rows.map((row) => row.event.event_id).sort((a, b) => a - b)).toEqual(
      [places.registered, places.laterRegistered, places.cancelled, places.queue, places.offer].sort((a, b) => a - b)
    );
    const registered = rowFor(rows, places.registered);
    expect(registered).toMatchObject({ registration_status: "REGISTERED", waitlistPosition: null, offer: null });
    expect(registered.event).toMatchObject({
      title: expect.stringContaining(`spm134-${runId}-event-`),
      attendee_status: "CONFIRMED",
      venue: { name: `spm32-${runId} Venue ${places.registered}`, address: "1 Synthetic Street" },
    });
    expect(Date.parse(registered.event.start_datetime)).toBeGreaterThan(Date.now());
    expect(Date.parse(registered.event.end_datetime)).toBeGreaterThan(Date.parse(registered.event.start_datetime));
    expect(rowFor(rows, places.queue)).toMatchObject({ registration_status: "WAITLISTED", waitlistPosition: 2, offer: null });
    const offered = rowFor(rows, places.offer);
    expect(offered).toMatchObject({ registration_status: "WAITLISTED", waitlistPosition: 1 });
    expect(offered.offer).toEqual({ offerId: expect.any(Number), expiresAt: expect.any(String) });
    expect(Date.parse(offered.offer.expiresAt)).toBeGreaterThan(Date.now());
  });

  test("[TC-MYE-003] a cancelled event keeps the attendee's place status apart from the event's", async () => {
    const row = rowFor(await listAll("myEvents", 100), places.cancelled);
    expect(row.registration_status).toBe("REGISTERED");
    expect(row.event.attendee_status).toBe("CANCELLED");
    expect(row.event).not.toHaveProperty("status");
    // Never confirmed, so no confirmed values exist to show (as on the event page).
    expect(row.event).toMatchObject({ start_datetime: null, venue: null });
  });

  test("[TC-MYE-010] a withdrawn place is not listed", async () => {
    expect(rowFor(await listAll("myEvents", 100), places.withdrawn)).toBeUndefined();
  });

  test("[TC-MYE-011] another attendee's places never appear", async () => {
    const rows = await listAll("myEvents", 100);
    expect(rowFor(rows, places.othersOnly)).toBeUndefined();
    expect(rowFor(await listAll("myEventsOther", 100), places.othersOnly)).toBeDefined();
  });

  test("[TC-MYE-006] an attendee with no places gets an empty page", async () => {
    const res = await getAs("myEventsEmpty", "/api/registrations/mine");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrations: [], page: { limit: 50, offset: 0, next_offset: null } });
  });

  test("[TC-MYE-013] walking two-place pages returns every place once, in the same order as one page", async () => {
    const paged = await listAll("myEvents", 2);
    const whole = await listAll("myEvents", 100);
    expect(paged.map((row) => row.registration_id)).toEqual(whole.map((row) => row.registration_id));
    expect(new Set(paged.map((row) => row.registration_id)).size).toBe(5);
  });

  test("[TC-MYE-012] other roles are refused", async () => {
    for (const key of NON_ATTENDEES) {
      const res = await getAs(key, "/api/registrations/mine");
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
    }
  });

  test("[TC-MYE-004] event details load through the existing event page, and only for the attendee's own places", async () => {
    const own = await getAs("myEvents", `/api/registrations/mine/${places.registered}`);
    expect(own.status).toBe(200);
    expect(own.body.event).toMatchObject({ eventId: places.registered, attendeeStatus: "CONFIRMED", detailsWithheld: false });
    expect(own.body.myRegistration).toMatchObject({ status: "REGISTERED", waitlistPosition: null, offer: null });
    const cancelled = await getAs("myEvents", `/api/registrations/mine/${places.cancelled}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.event).toMatchObject({ attendeeStatus: "CANCELLED", detailsWithheld: true });
    expect((await getAs("myEvents", `/api/registrations/mine/${places.othersOnly}`)).status).toBe(404);
    expect((await getAs("myEvents", `/api/registrations/mine/${places.withdrawn}`)).status).toBe(404);
  });

  test("[TC-MYE-007] the queue position is recalculated when someone ahead leaves", async () => {
    expect((await postAs("myEventsOther", `/api/registrations/mine/${places.queue}/waitlist/leave`)).status).toBe(200);
    expect(rowFor(await listAll("myEvents", 100), places.queue)).toMatchObject({ registration_status: "WAITLISTED", waitlistPosition: 1 });
  });

  test("[TC-MYE-008] the listed offer ID is the one Accept takes, and the accepted place then lists as registered", async () => {
    const { offer } = rowFor(await listAll("myEvents", 100), places.offer);
    const accepted = await postAs("myEvents", `/api/registrations/mine/${places.offer}/offer/accept`, { offerId: offer.offerId });
    expect(accepted.status).toBe(200);
    expect(accepted.body.registration.status).toBe("REGISTERED");
    expect(rowFor(await listAll("myEvents", 100), places.offer)).toMatchObject({
      registration_status: "REGISTERED",
      waitlistPosition: null,
      offer: null,
    });
  });

  test("[TC-MYE-009] a listed registered place can be withdrawn through SPM-147 and then leaves the list", async () => {
    const res = await postAs("myEvents", `/api/registrations/mine/${places.laterRegistered}/withdraw`);
    expect(res.status).toBe(200);
    expect(res.body.registration.status).toBe("WITHDRAWN");
    expect(rowFor(await listAll("myEvents", 100), places.laterRegistered)).toBeUndefined();
  });
});
