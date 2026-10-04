const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const supabase = require("../../config/supabase");

// Every record is namespaced by run ID and listed in a manifest as soon as it
// exists, so cleanup removes exactly what this run created, even after a crash.
const MANIFEST_DIR = path.join(__dirname, "manifests");
const TEST_EMAIL_DOMAIN = "connectsphere.test";

const ACCOUNTS = [
  { key: "organiserA", role: "ORGANISER", organisation: "A" },
  { key: "organiserA2", role: "ORGANISER", organisation: "A" },
  { key: "organiserB", role: "ORGANISER", organisation: "B" },
  { key: "organiserSolo", role: "ORGANISER" },
  { key: "coordinator", role: "COORDINATOR" },
  { key: "venueStaff", role: "VENUE_STAFF" },
  { key: "techSupport", role: "TECH_SUPPORT" },
  { key: "attendee", role: "ATTENDEE" },
  { key: "deactivatable", role: "ATTENDEE" },
  { key: "inactive", role: "ATTENDEE", inactive: true },
  { key: "unlinked", role: null },
];

const EVENT_SPECS = {
  ownSubmitted: { organiser: "organiserA", organisation: "A", status: "SUBMITTED" },
  ownDraft: { organiser: "organiserA", organisation: "A", status: "DRAFT" },
  colleagueSubmitted: { organiser: "organiserA2", organisation: "A", status: "SUBMITTED" },
  colleagueDraft: { organiser: "organiserA2", organisation: "A", status: "DRAFT" },
  otherOrganisation: { organiser: "organiserB", organisation: "B", status: "SUBMITTED" },
  soloSubmitted: { organiser: "organiserSolo", organisation: null, status: "SUBMITTED" },
  registeredConfirmed: { organiser: "organiserB", organisation: "B", status: "CONFIRMED", published: true },
  registeredPlanning: { organiser: "organiserB", organisation: "B", status: "PLANNING" },
};

const BOOKING_SPECS = [
  { event: "registeredConfirmed", status: "REJECTED", start: "2027-03-01T01:00:00Z", end: "2027-03-01T03:00:00Z" },
  { event: "registeredConfirmed", status: "APPROVED", start: "2027-03-02T01:00:00Z", end: "2027-03-02T03:00:00Z" },
  { event: "registeredPlanning", status: "APPROVED", start: "2027-03-03T01:00:00Z", end: "2027-03-03T03:00:00Z" },
];

const REGISTRATION_SPECS = [
  { event: "registeredConfirmed", status: "REGISTERED" },
  { event: "registeredPlanning", status: "WAITLISTED" },
  { event: "ownSubmitted", status: "WITHDRAWN" },
];

const check = ({ data, error }, step) => {
  if (error) {
    throw new Error(`Fixture step "${step}" failed: ${error.message}`);
  }
  return data;
};

const newRunId = () => `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;

const manifestPath = (runId) => path.join(MANIFEST_DIR, `spm32-${runId}.json`);

const emptyManifest = (runId) => ({
  runId,
  authUserIds: [],
  userIds: [],
  organisationIds: [],
  venueIds: [],
  roomIds: [],
  eventIds: [],
  bookingIds: [],
  registrationIds: [],
});

const saveManifest = (manifest) => {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(manifestPath(manifest.runId), JSON.stringify(manifest, null, 2));
};

const insertOne = async (table, row, idColumn, step) =>
  check(await supabase.from(table).insert(row).select(idColumn).single(), step)[idColumn];

// Callers pass a run ID they already hold, so a failure part-way through
// setup can still be cleaned up from the manifest.
const createAuthFixtures = async (runId) => {
  const password = `Spm32-${crypto.randomBytes(12).toString("base64url")}`;
  const manifest = emptyManifest(runId);
  saveManifest(manifest);

  const record = (list, id) => {
    manifest[list].push(id);
    saveManifest(manifest);
    return id;
  };

  const organisations = { A: null, B: null };
  for (const label of Object.keys(organisations)) {
    organisations[label] = record("organisationIds", await insertOne(
      "organisation",
      { name: `spm32-${runId} Organisation ${label}` },
      "organisation_id",
      `organisation ${label}`,
    ));
  }

  const accounts = {};
  for (const account of ACCOUNTS) {
    const email = `spm32-${runId}-${account.key.toLowerCase()}@${TEST_EMAIL_DOMAIN}`;
    const authUser = check(
      await supabase.auth.admin.createUser({ email, password, email_confirm: true }),
      `auth user ${account.key}`,
    ).user;
    record("authUserIds", authUser.id);
    accounts[account.key] = { email, password, authUserId: authUser.id, role: account.role };

    if (!account.role) {
      continue;
    }

    const userId = record("userIds", await insertOne(
      "user",
      { email, name: `spm32 ${account.key}`, role: account.role, auth_user_id: authUser.id, is_active: !account.inactive },
      "user_id",
      `profile ${account.key}`,
    ));
    accounts[account.key].userId = userId;

    if (account.organisation) {
      check(
        await supabase.from("organisation_membership").insert({ organisation_id: organisations[account.organisation], user_id: userId }),
        `membership ${account.key}`,
      );
    }
  }

  const venueId = record("venueIds", await insertOne(
    "venue",
    { name: `spm32-${runId} Hall`, address: `spm32-${runId} 1 Test Road`, max_capacity: 200 },
    "venue_id",
    "venue",
  ));
  const roomId = record("roomIds", await insertOne(
    "room",
    { venue_id: venueId, layout_type: "THEATRE", capacity: 200 },
    "room_id",
    "room",
  ));

  const events = {};
  for (const [key, spec] of Object.entries(EVENT_SPECS)) {
    events[key] = record("eventIds", await insertOne(
      "event",
      {
        title: `spm32-${runId} ${key}`,
        description: `Synthetic ${key} event`,
        purpose: "Internal planning purpose that attendees must not see",
        accessibility_needs: "Internal accessibility note",
        organiser_id: accounts[spec.organiser].userId,
        organisation_id: spec.organisation ? organisations[spec.organisation] : null,
        coordinator_id: spec.status === "DRAFT" ? null : accounts.coordinator.userId,
        status: spec.status,
        expected_attendance: 50,
        is_published: Boolean(spec.published),
      },
      "event_id",
      `event ${key}`,
    ));
  }

  for (const spec of BOOKING_SPECS) {
    record("bookingIds", await insertOne(
      "venue_booking",
      {
        room_id: roomId,
        event_id: events[spec.event],
        requested_by: accounts.coordinator.userId,
        start_datetime: spec.start,
        end_datetime: spec.end,
        status: spec.status,
      },
      "booking_id",
      `booking ${spec.event} ${spec.status}`,
    ));
  }

  for (const spec of REGISTRATION_SPECS) {
    record("registrationIds", await insertOne(
      "registration",
      { attendee_id: accounts.attendee.userId, event_id: events[spec.event], registration_status: spec.status },
      "registration_id",
      `registration ${spec.event}`,
    ));
  }

  return { runId, accounts, organisations, events, venue: { venueId, roomId } };
};

// Only ever changes a profile this run created.
const setFixtureProfileActive = async (fixtures, accountKey, isActive) => {
  const { userId } = fixtures.accounts[accountKey];
  check(
    await supabase.from("user").update({ is_active: isActive }).eq("user_id", userId).like("email", `spm32-${fixtures.runId}-%`),
    `set ${accountKey} active=${isActive}`,
  );
};

const countFixtureActivity = async (fixtures) => {
  const userIds = Object.values(fixtures.accounts).map((account) => account.userId).filter(Boolean);
  const { count, error } = await supabase
    .from("activity_log")
    .select("log_id", { count: "exact", head: true })
    .in("user_id", userIds);
  if (error) {
    throw new Error(`Activity count failed: ${error.message}`);
  }
  return count;
};

const deleteIn = async (table, column, ids) => {
  if (ids.length) {
    check(await supabase.from(table).delete().in(column, ids), `delete ${table}`);
  }
};

// Throws if anything this run created is still present.
const verifyManifestClean = async (manifest) => {
  const leftovers = [];
  const tables = [
    ["registration", "registration_id", manifest.registrationIds],
    ["venue_booking", "booking_id", manifest.bookingIds],
    ["event", "event_id", manifest.eventIds],
    ["organisation_membership", "user_id", manifest.userIds],
    ["user", "user_id", manifest.userIds],
    ["room", "room_id", manifest.roomIds],
    ["venue", "venue_id", manifest.venueIds],
    ["organisation", "organisation_id", manifest.organisationIds],
  ];
  for (const [table, column, ids] of tables) {
    if (!ids.length) {
      continue;
    }
    const { count, error } = await supabase.from(table).select(column, { count: "exact", head: true }).in(column, ids);
    if (error || count > 0) {
      leftovers.push(`${table}: ${error ? error.message : count}`);
    }
  }
  for (const authUserId of manifest.authUserIds) {
    const { data } = await supabase.auth.admin.getUserById(authUserId);
    if (data && data.user) {
      leftovers.push(`auth user ${authUserId}`);
    }
  }
  if (leftovers.length) {
    throw new Error(`Fixture cleanup incomplete for run ${manifest.runId}: ${leftovers.join("; ")}`);
  }
};

// Dependency-safe order; Auth accounts last so profiles never dangle mid-cleanup.
const cleanupManifest = async (manifest) => {
  await deleteIn("registration", "registration_id", manifest.registrationIds);
  await deleteIn("venue_booking", "booking_id", manifest.bookingIds);
  await deleteIn("event", "event_id", manifest.eventIds);
  await deleteIn("organisation_membership", "user_id", manifest.userIds);
  await deleteIn("user", "user_id", manifest.userIds);
  await deleteIn("room", "room_id", manifest.roomIds);
  await deleteIn("venue", "venue_id", manifest.venueIds);
  await deleteIn("organisation", "organisation_id", manifest.organisationIds);
  for (const authUserId of manifest.authUserIds) {
    const { error } = await supabase.auth.admin.deleteUser(authUserId);
    if (error && error.status !== 404) {
      throw new Error(`Fixture step "delete auth user" failed: ${error.message}`);
    }
  }

  await verifyManifestClean(manifest);
  fs.rmSync(manifestPath(manifest.runId), { force: true });
};

const cleanupAuthFixtures = async (runId) => {
  const file = manifestPath(runId);
  if (fs.existsSync(file)) {
    await cleanupManifest(JSON.parse(fs.readFileSync(file, "utf8")));
  }
};

module.exports = {
  newRunId,
  createAuthFixtures,
  cleanupAuthFixtures,
  cleanupManifest,
  setFixtureProfileActive,
  countFixtureActivity,
  MANIFEST_DIR,
};
