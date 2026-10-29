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
const { createRegistrationFixtures } = require("../fixtures/registrationFixtures");

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

// Each event gets its own day, so fixture events never share a time slot.
const insertEvent = async (overrides = {}) => {
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

// A refused attempt must leave no registration, confirmation or activity.
const expectNothingWritten = async (eventId, before) => {
  expect(await registrationsFor(eventId)).toEqual(before.registrations);
  expect(await confirmationsFor(eventId)).toEqual(before.confirmations);
};
const snapshot = async (eventId) => ({ registrations: await registrationsFor(eventId), confirmations: await confirmationsFor(eventId) });

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
  ]);
});

// Runs even when setup stopped part-way: the manifest lists what was created.
afterAll(async () => {
  await cleanupAuthFixtures(runId);
});

describe("[SPM-134] authentication and role", () => {
  test("[SPM-134] should_return_401_and_register_nothing_when_there_is_no_token", async () => {
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

  test("[SPM-134] should_register_only_the_signed_in_attendee_when_the_body_names_another_user", async () => {
    const eventId = await insertEvent();
    const forged = await registerAs("attendee", eventId, { ...answers(), userId: fixtures.accounts.racer.userId, attendeeId: 1 });
    expect(forged.status).toBe(400);
    expect(Object.keys(forged.body.fields).sort()).toEqual(["attendeeId", "userId"]);
    expect(await registrationsFor(eventId)).toEqual([]);
  });
});

describe("[SPM-134] successful registration", () => {
  test("[SPM-134] should_register_with_event_specific_answers_and_leave_the_saved_profile_unchanged", async () => {
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

  test("[SPM-134] should_register_with_blank_answers_when_the_attendee_has_no_saved_profile", async () => {
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
      const res = await registerAs("racer", eventId);
      recordRegistrations([res]);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe("EVENT_NOT_FOUND");
      expect(await registrationsFor(eventId)).toEqual([]);
      expect(await confirmationsFor(eventId)).toEqual([]);
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
  test("[SPM-134] should_return_409_already_registered_and_write_nothing_when_the_attendee_registers_again", async () => {
    const eventId = await insertEvent();
    const first = await registerAs("racer", eventId, answers("Vegan"));
    recordRegistrations([first]);
    const before = await snapshot(eventId);
    const again = await registerAs("racer", eventId, answers("Halal"));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_REGISTERED");
    await expectNothingWritten(eventId, before);
  });

  test("[SPM-134] should_create_exactly_one_registration_when_the_same_attendee_registers_in_parallel", async () => {
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
  test("[SPM-134] should_return_409_registration_full_without_a_waitlist_row_when_capacity_is_reached", async () => {
    const eventId = await insertEvent({ registration_capacity: 1 });
    await insertRegistration(eventId, "deactivatable", "REGISTERED");
    const before = await snapshot(eventId);
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_FULL");
    await expectNothingWritten(eventId, before);
    expect((await registrationsFor(eventId)).filter((row) => row.registration_status === "WAITLISTED")).toEqual([]);
  });

  test.each(Array.from({ length: RACE_ROUNDS }, (_, round) => [round + 1]))(
    "[SPM-134] should_give_the_last_place_to_exactly_one_attendee_when_two_register_in_parallel_round_%i",
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

describe("[SPM-134] registration window and enablement", () => {
  test.each([
    ["the_window_has_closed", { registration_close_at: new Date(Date.now() - 60 * 1000).toISOString() }],
    ["the_window_has_not_opened", { registration_open_at: new Date(Date.now() + DAY).toISOString() }],
  ])("[SPM-134] should_return_409_registration_closed_and_write_nothing_when_%s", async (label, overrides) => {
    const eventId = await insertEvent(overrides);
    const before = await snapshot(eventId);
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_CLOSED");
    await expectNothingWritten(eventId, before);
  });

  test("[SPM-134] should_return_registration_closed_not_full_when_the_window_has_closed_on_a_full_event", async () => {
    const eventId = await insertEvent({ registration_capacity: 1, registration_close_at: new Date(Date.now() - 60 * 1000).toISOString() });
    await insertRegistration(eventId, "deactivatable", "REGISTERED");
    const res = await registerAs("racer", eventId);
    expect(res.body.code).toBe("REGISTRATION_CLOSED");
  });

  test("[SPM-134] should_return_409_registration_not_enabled_when_the_organiser_has_not_enabled_registration", async () => {
    const eventId = await insertEvent({ is_registration_enabled: false, registration_capacity: null });
    const res = await registerAs("racer", eventId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("REGISTRATION_NOT_ENABLED");
    expect(await registrationsFor(eventId)).toEqual([]);
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
  ])("[SPM-134] should_return_400_and_register_nothing_when_the_body_has_%s", async (label, body) => {
    const eventId = await insertEvent();
    const res = await registerAs("racer", eventId, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(await registrationsFor(eventId)).toEqual([]);
  });
});
