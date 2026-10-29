// Minimal live fixtures for event registration (SPM-134): login-capable
// accounts and one organisation, nothing else. Registration reads no venue,
// room, booking or equipment data, so the suite does not depend on the shared
// builder's event and booking set. Each suite creates its own events.
// Accounts are created through Auth Admin, never raw SQL (Master 10.4), and
// use the shared spm32-<run> naming and manifest, so cleanupAuthFixtures and
// npm run test:cleanup remove them like any other run.
const crypto = require("crypto");
const supabase = require("../../config/supabase");
const { startFixtureManifest, recordFixtureIds } = require("./authFixtures");

const TEST_EMAIL_DOMAIN = "connectsphere.test";

const check = ({ data, error }, step) => {
  if (error) throw new Error(`Fixture step "${step}" failed: ${error.message}`);
  return data;
};

// accounts: [{ key, role, organisation? }]; organisation "A" is the only one created.
const createRegistrationFixtures = async (runId, accounts) => {
  const password = `Spm134-${crypto.randomBytes(12).toString("base64url")}`;
  startFixtureManifest(runId);

  const organisationId = check(
    await supabase.from("organisation").insert({ name: `spm32-${runId} Organisation A` }).select("organisation_id").single(),
    "organisation A"
  ).organisation_id;
  recordFixtureIds(runId, "organisationIds", [organisationId]);

  const created = {};
  for (const account of accounts) {
    const email = `spm32-${runId}-${account.key.toLowerCase()}@${TEST_EMAIL_DOMAIN}`;
    const authUser = check(await supabase.auth.admin.createUser({ email, password, email_confirm: true }), `auth user ${account.key}`).user;
    recordFixtureIds(runId, "authUserIds", [authUser.id]);

    const userId = check(
      await supabase
        .from("user")
        .insert({ email, name: `spm32 ${account.key}`, role: account.role, auth_user_id: authUser.id, is_active: true })
        .select("user_id")
        .single(),
      `profile ${account.key}`
    ).user_id;
    recordFixtureIds(runId, "userIds", [userId]);

    if (account.organisation === "A") {
      check(await supabase.from("organisation_membership").insert({ organisation_id: organisationId, user_id: userId }), `membership ${account.key}`);
    }
    created[account.key] = { email, password, authUserId: authUser.id, userId, role: account.role };
  }

  return { runId, accounts: created, organisations: { A: organisationId } };
};

module.exports = { createRegistrationFixtures };
