const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const supabase = require("../../config/supabase");

// Every record is namespaced by run ID and listed in a manifest as soon as it
// exists, so cleanup removes exactly what this run created, even after a crash.
const MANIFEST_DIR = path.join(__dirname, "manifests");

const ACCOUNTS = [
  { key: "organiserA", role: "ORGANISER", organisation: "A" },
  { key: "organiserA2", role: "ORGANISER", organisation: "A" },
  { key: "organiserB", role: "ORGANISER", organisation: "B" },
  { key: "coordinator", role: "COORDINATOR" },
  { key: "venueStaff", role: "VENUE_STAFF" },
  { key: "techSupport", role: "TECH_SUPPORT" },
  { key: "attendee", role: "ATTENDEE" },
  { key: "inactive", role: "ATTENDEE", inactive: true },
  { key: "unlinked", role: null },
];

const check = ({ data, error }, step) => {
  if (error) {
    throw new Error(`Fixture step "${step}" failed: ${error.message}`);
  }
  return data;
};

const manifestPath = (runId) => path.join(MANIFEST_DIR, `spm32-${runId}.json`);

const saveManifest = (manifest) => {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(manifestPath(manifest.runId), JSON.stringify(manifest, null, 2));
};

const createAuthFixtures = async () => {
  const runId = `${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  const password = `Spm32-${crypto.randomBytes(12).toString("base64url")}`;
  const manifest = {
    runId,
    authUserIds: [],
    userIds: [],
    organisationIds: [],
    memberships: [],
    eventIds: [],
    registrationIds: [],
  };
  saveManifest(manifest);

  const organisations = {};
  for (const label of ["A", "B"]) {
    const row = check(
      await supabase.from("organisation").insert({ name: `spm32-${runId} Organisation ${label}` }).select("organisation_id").single(),
      `organisation ${label}`,
    );
    organisations[label] = row.organisation_id;
    manifest.organisationIds.push(row.organisation_id);
    saveManifest(manifest);
  }

  const accounts = {};
  for (const account of ACCOUNTS) {
    const email = `spm32-${runId}-${account.key.toLowerCase()}@connectsphere.test`;
    const authUser = check(
      await supabase.auth.admin.createUser({ email, password, email_confirm: true }),
      `auth user ${account.key}`,
    ).user;
    manifest.authUserIds.push(authUser.id);
    saveManifest(manifest);

    accounts[account.key] = { email, password, authUserId: authUser.id };
    if (!account.role) {
      continue;
    }

    const profile = check(
      await supabase
        .from("user")
        .insert({
          email,
          name: `spm32 ${account.key}`,
          role: account.role,
          auth_user_id: authUser.id,
          is_active: !account.inactive,
        })
        .select("user_id")
        .single(),
      `profile ${account.key}`,
    );
    manifest.userIds.push(profile.user_id);
    saveManifest(manifest);
    accounts[account.key].userId = profile.user_id;

    if (account.organisation) {
      const membership = { organisation_id: organisations[account.organisation], user_id: profile.user_id };
      check(await supabase.from("organisation_membership").insert(membership), `membership ${account.key}`);
      manifest.memberships.push(membership);
      saveManifest(manifest);
    }
  }

  const eventSpecs = {
    ownSubmitted: { organiser: "organiserA", organisation: "A", status: "SUBMITTED" },
    ownDraft: { organiser: "organiserA", organisation: "A", status: "DRAFT" },
    colleagueSubmitted: { organiser: "organiserA2", organisation: "A", status: "SUBMITTED" },
    colleagueDraft: { organiser: "organiserA2", organisation: "A", status: "DRAFT" },
    otherOrganisation: { organiser: "organiserB", organisation: "B", status: "SUBMITTED" },
    registeredConfirmed: { organiser: "organiserB", organisation: "B", status: "CONFIRMED", is_published: true },
  };

  const events = {};
  for (const [key, spec] of Object.entries(eventSpecs)) {
    const row = check(
      await supabase
        .from("event")
        .insert({
          title: `spm32-${runId} ${key}`,
          organiser_id: accounts[spec.organiser].userId,
          organisation_id: organisations[spec.organisation],
          coordinator_id: spec.status === "DRAFT" ? null : accounts.coordinator.userId,
          status: spec.status,
          is_published: Boolean(spec.is_published),
        })
        .select("event_id")
        .single(),
      `event ${key}`,
    );
    events[key] = row.event_id;
    manifest.eventIds.push(row.event_id);
    saveManifest(manifest);
  }

  const registrationSpecs = [
    { event: "registeredConfirmed", status: "REGISTERED" },
    { event: "ownSubmitted", status: "WITHDRAWN" },
  ];
  for (const spec of registrationSpecs) {
    const row = check(
      await supabase
        .from("registration")
        .insert({ attendee_id: accounts.attendee.userId, event_id: events[spec.event], registration_status: spec.status })
        .select("registration_id")
        .single(),
      `registration ${spec.event}`,
    );
    manifest.registrationIds.push(row.registration_id);
    saveManifest(manifest);
  }

  return { runId, accounts, organisations, events };
};

// Dependency-safe order; Auth accounts last so profiles never dangle mid-cleanup.
const cleanupManifest = async (manifest) => {
  if (manifest.registrationIds.length) {
    check(await supabase.from("registration").delete().in("registration_id", manifest.registrationIds), "delete registrations");
  }
  if (manifest.eventIds.length) {
    check(await supabase.from("event").delete().in("event_id", manifest.eventIds), "delete events");
  }
  if (manifest.memberships.length) {
    check(await supabase.from("organisation_membership").delete().in("user_id", manifest.userIds), "delete memberships");
  }
  if (manifest.userIds.length) {
    check(await supabase.from("user").delete().in("user_id", manifest.userIds), "delete profiles");
  }
  if (manifest.organisationIds.length) {
    check(await supabase.from("organisation").delete().in("organisation_id", manifest.organisationIds), "delete organisations");
  }
  for (const authUserId of manifest.authUserIds) {
    check(await supabase.auth.admin.deleteUser(authUserId), `delete auth user ${authUserId}`);
  }
  fs.rmSync(manifestPath(manifest.runId), { force: true });
};

const cleanupAuthFixtures = async (runId) => {
  const file = manifestPath(runId);
  if (fs.existsSync(file)) {
    await cleanupManifest(JSON.parse(fs.readFileSync(file, "utf8")));
  }
};

module.exports = { createAuthFixtures, cleanupAuthFixtures, cleanupManifest, MANIFEST_DIR };
