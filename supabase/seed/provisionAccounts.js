// Creates login-capable synthetic accounts for every role on the shared
// development project (Master section 10.4), or removes them again.
//
//   npm run seed:accounts           create or repair the accounts (idempotent)
//   npm run seed:accounts:cleanup   remove exactly what the manifest lists
//
// Requires SEED_ACCOUNT_PASSWORD in .env (private; never commit or share it).
// SEED_NAMESPACE (default "dev") prefixes every email and organisation name.
const fs = require("fs");
const path = require("path");
const supabase = require("../../config/supabase");

const NAMESPACE = process.env.SEED_NAMESPACE || "dev";
const PASSWORD = process.env.SEED_ACCOUNT_PASSWORD;
const EMAIL_DOMAIN = "connectsphere.test";
const MANIFEST_DIR = path.join(__dirname, "manifests");
const MANIFEST_PATH = path.join(MANIFEST_DIR, `accounts-${NAMESPACE}.json`);

const ORGANISATIONS = ["A", "B"];

const ACCOUNTS = [
  { key: "organiser-a", name: "Seed Organiser A", role: "ORGANISER", organisation: "A" },
  { key: "organiser-b", name: "Seed Organiser B", role: "ORGANISER", organisation: "B" },
  { key: "coordinator", name: "Seed Coordinator", role: "COORDINATOR" },
  { key: "venue-staff", name: "Seed Venue Staff", role: "VENUE_STAFF" },
  { key: "tech-support", name: "Seed Tech Support", role: "TECH_SUPPORT" },
  { key: "attendee", name: "Seed Attendee", role: "ATTENDEE" },
];

const emailFor = (account) => `${NAMESPACE}-${account.key}@${EMAIL_DOMAIN}`;
const organisationName = (label) => `${NAMESPACE} Organisation ${label}`;

const check = ({ data, error }, step) => {
  if (error) {
    throw new Error(`${step} failed: ${error.message}`);
  }
  return data;
};

const loadManifest = () => (fs.existsSync(MANIFEST_PATH)
  ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
  : { namespace: NAMESPACE, authUserIds: [], userIds: [], organisationIds: [] });

const saveManifest = (manifest) => {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
};

const remember = (manifest, list, id) => {
  if (!manifest[list].includes(id)) {
    manifest[list].push(id);
    saveManifest(manifest);
  }
};

const findAuthUserByEmail = async (email) => {
  for (let page = 1; ; page += 1) {
    const { users } = check(await supabase.auth.admin.listUsers({ page, perPage: 1000 }), "list auth users");
    const match = users.find((user) => user.email === email);
    if (match || users.length < 1000) {
      return match || null;
    }
  }
};

const ensureOrganisation = async (manifest, label) => {
  const name = organisationName(label);
  const existing = check(
    await supabase.from("organisation").select("organisation_id").eq("name", name).maybeSingle(),
    `find organisation ${label}`,
  );
  const id = existing
    ? existing.organisation_id
    : check(await supabase.from("organisation").insert({ name }).select("organisation_id").single(), `create organisation ${label}`).organisation_id;
  remember(manifest, "organisationIds", id);
  return id;
};

// Re-running resets the password and confirms the email, so the accounts
// always match the current SEED_ACCOUNT_PASSWORD.
const ensureAuthUser = async (manifest, email) => {
  const existing = await findAuthUserByEmail(email);
  const authUser = existing
    ? check(await supabase.auth.admin.updateUserById(existing.id, { password: PASSWORD, email_confirm: true }), `update ${email}`).user
    : check(await supabase.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true }), `create ${email}`).user;
  remember(manifest, "authUserIds", authUser.id);
  return authUser.id;
};

const ensureProfile = async (manifest, account, email, authUserId) => {
  const profile = { email, name: account.name, role: account.role, auth_user_id: authUserId, is_active: true };
  const existing = check(
    await supabase.from("user").select("user_id").eq("email", email).maybeSingle(),
    `find profile ${email}`,
  );
  const userId = existing
    ? check(await supabase.from("user").update(profile).eq("user_id", existing.user_id).select("user_id").single(), `update profile ${email}`).user_id
    : check(await supabase.from("user").insert(profile).select("user_id").single(), `create profile ${email}`).user_id;
  remember(manifest, "userIds", userId);
  return userId;
};

const provision = async () => {
  if (!PASSWORD || PASSWORD.length < 12) {
    throw new Error("Set SEED_ACCOUNT_PASSWORD (at least 12 characters) in .env first.");
  }

  const manifest = loadManifest();
  const organisations = {};
  for (const label of ORGANISATIONS) {
    organisations[label] = await ensureOrganisation(manifest, label);
  }

  for (const account of ACCOUNTS) {
    const email = emailFor(account);
    const authUserId = await ensureAuthUser(manifest, email);
    const userId = await ensureProfile(manifest, account, email, authUserId);

    if (account.organisation) {
      check(
        await supabase
          .from("organisation_membership")
          .upsert({ organisation_id: organisations[account.organisation], user_id: userId }, { ignoreDuplicates: true }),
        `membership ${email}`,
      );
    }
    console.log(`${account.role.padEnd(13)} ${email}`);
  }
  console.log(`Accounts ready (namespace "${NAMESPACE}"). The password is SEED_ACCOUNT_PASSWORD from .env.`);
};

// Removes only what the manifest lists. Profiles referenced by events or
// registrations are kept and reported rather than force-deleted.
const cleanup = async () => {
  const manifest = loadManifest();
  const failures = [];

  if (manifest.userIds.length) {
    check(await supabase.from("organisation_membership").delete().in("user_id", manifest.userIds), "delete memberships");
  }
  for (const userId of manifest.userIds) {
    const { error } = await supabase.from("user").delete().eq("user_id", userId);
    if (error) {
      failures.push(`profile ${userId}: ${error.message}`);
    }
  }
  for (const organisationId of manifest.organisationIds) {
    const { error } = await supabase.from("organisation").delete().eq("organisation_id", organisationId);
    if (error) {
      failures.push(`organisation ${organisationId}: ${error.message}`);
    }
  }
  if (failures.length === 0) {
    for (const authUserId of manifest.authUserIds) {
      const { error } = await supabase.auth.admin.deleteUser(authUserId);
      if (error && error.status !== 404) {
        failures.push(`auth user ${authUserId}: ${error.message}`);
      }
    }
  }

  if (failures.length) {
    throw new Error(`Cleanup incomplete; kept the manifest:\n${failures.join("\n")}`);
  }
  fs.rmSync(MANIFEST_PATH, { force: true });
  console.log(`Removed seed accounts for namespace "${NAMESPACE}".`);
};

if (!/^[a-z0-9-]{2,40}$/.test(NAMESPACE)) {
  console.error("SEED_NAMESPACE may contain only lowercase letters, digits and hyphens.");
  process.exitCode = 1;
} else {
  (process.argv[2] === "cleanup" ? cleanup() : provision()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
