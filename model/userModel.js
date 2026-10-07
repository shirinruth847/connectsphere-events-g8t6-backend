const supabase = require("../config/supabase");

const PROFILE_COLUMNS = "user_id, email, name, role, is_active, organisation_membership(organisation_id)";

const isClientAuthError = (error) => error.status >= 400 && error.status < 500;

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

module.exports = {
  findUserByAuthId,
  verifyAccessToken,
  revokeSession,
};
