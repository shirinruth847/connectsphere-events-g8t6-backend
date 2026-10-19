const supabase = require("../config/supabase");

const PROFILE_COLUMNS = "user_id, email, name, role, is_active, organisation_membership(organisation_id)";

const isClientAuthError = (error) => error.status >= 400 && error.status < 500;

// Set only by self sign-up. app_metadata is not editable by the user, so it
// reliably marks Auth accounts that this flow created.
const SIGNUP_MARKER = "signup_account_type";
// An unlinked sign-up account younger than this may still be mid-creation.
const ORPHAN_MIN_AGE_MS = 2 * 60 * 1000;
const UNIQUE_VIOLATION = "23505";

const signupError = (code) => {
  const error = new Error(code);
  error.name = "SignupError";
  error.code = code;
  return error;
};

const authFailure = (error) => new Error(`[Supabase Auth Error] ${error.status} ${error.code || error.name}`);

const findUserByAuthId = async (authUserId) => {
  const { data, error } = await supabase
    .from("user")
    .select(PROFILE_COLUMNS)
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (error) {
    throw new Error(`[Supabase Error] ${error.message}`);
  }
  if (!data || !data.is_active) {
    return null;
  }

  return {
    user_id: data.user_id,
    email: data.email,
    name: data.name,
    role: data.role,
    organisation_ids: data.organisation_membership.map((membership) => membership.organisation_id),
  };
};

// Asks Supabase Auth rather than checking the JWT locally, so a token whose
// session was revoked at logout is rejected before it expires.
const verifyAccessToken = async (accessToken) => {
  const { data, error } = await supabase.auth.getUser(accessToken);

  if (!error) {
    return data.user.id;
  }
  if (isClientAuthError(error)) {
    return null;
  }
  throw new Error(`[Supabase Auth Error] ${error.status} ${error.code || error.name}`);
};

// Revokes only the session this access token belongs to; the user's other
// devices stay signed in. Already-revoked or expired tokens are not an error.
const revokeSession = async (accessToken) => {
  const { error } = await supabase.auth.admin.signOut(accessToken, "local");

  if (error && !isClientAuthError(error)) {
    throw new Error(`[Supabase Auth Error] ${error.status} ${error.code || error.name}`);
  }
};

const findAuthUserByEmail = async (email) => {
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) {
      throw authFailure(error);
    }
    const match = data.users.find((user) => (user.email || "").toLowerCase() === email);
    if (match || data.users.length < 1000) {
      return match || null;
    }
  }
};

// Deletes an Auth account created by sign-up whose profile was never written,
// for example after a crash between the two steps. Accounts created any other
// way, linked to a profile, or still young enough to be mid-creation are kept.
const removeOrphanedSignup = async (email) => {
  const authUser = await findAuthUserByEmail(email);
  if (!authUser || !(authUser.app_metadata && authUser.app_metadata[SIGNUP_MARKER])) {
    return false;
  }
  if (Date.now() - new Date(authUser.created_at).getTime() < ORPHAN_MIN_AGE_MS) {
    return false;
  }

  const { data: profile, error } = await supabase
    .from("user")
    .select("user_id")
    .eq("auth_user_id", authUser.id)
    .maybeSingle();
  if (error) {
    throw new Error(`[Supabase Error] ${error.message}`);
  }
  if (profile) {
    return false;
  }

  const { error: deleteError } = await supabase.auth.admin.deleteUser(authUser.id);
  if (deleteError) {
    throw authFailure(deleteError);
  }
  return true;
};

const createAuthAccount = async ({ email, password, accountType }) =>
  supabase.auth.admin.createUser({
    email,
    password,
    // Email verification is deferred (SPM-123 decision), so accounts can sign in at once.
    email_confirm: true,
    app_metadata: { [SIGNUP_MARKER]: accountType },
  });

// Removes the Auth account when its profile could not be written. A failure
// here is logged with the Auth user ID so the orphan can be found later.
const compensateAuthAccount = async (authUserId) => {
  const { error } = await supabase.auth.admin.deleteUser(authUserId);
  if (error) {
    console.error("[signup] could not remove Auth account after profile failure", {
      authUserId,
      status: error.status,
      code: error.code,
    });
  }
};

// Supabase Auth and the application tables cannot share a transaction, so the
// Auth account is created first and deleted again if the profile insert fails.
// The role comes only from the validated account type, never from the client.
const createSignupAccount = async ({ accountType, name, email, password }) => {
  let { data, error } = await createAuthAccount({ email, password, accountType });

  if (error && error.code === "email_exists" && (await removeOrphanedSignup(email))) {
    ({ data, error } = await createAuthAccount({ email, password, accountType }));
  }
  if (error) {
    if (error.code === "email_exists" || error.code === "user_already_exists") throw signupError("EMAIL_UNAVAILABLE");
    if (error.code === "weak_password") throw signupError("WEAK_PASSWORD");
    if (error.code === "validation_failed" || error.code === "email_address_invalid") throw signupError("INVALID_SIGNUP_DETAILS");
    // When requests for one email race, Supabase Auth can answer the losers
    // with a 5xx instead of email_exists. If the account now exists, this
    // request lost the race and gets the same answer as any duplicate.
    if (!isClientAuthError(error) && (await findAuthUserByEmail(email))) throw signupError("EMAIL_UNAVAILABLE");
    throw authFailure(error);
  }

  const authUserId = data.user.id;
  const { data: profile, error: profileError } = await supabase
    .from("user")
    .insert({ email, name, role: accountType, auth_user_id: authUserId, is_active: true })
    .select("user_id, email, name, role")
    .single();

  if (profileError) {
    await compensateAuthAccount(authUserId);
    // A profile already holds this email (e.g. one not yet linked to Auth).
    if (profileError.code === UNIQUE_VIOLATION) throw signupError("EMAIL_UNAVAILABLE");
    throw new Error(`[Supabase Error] ${profileError.message}`);
  }

  return profile;
};

module.exports = {
  findUserByAuthId,
  verifyAccessToken,
  revokeSession,
  createSignupAccount,
};
