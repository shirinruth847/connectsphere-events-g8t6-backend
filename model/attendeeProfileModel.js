// The signed-in attendee's profile (SPM-270). Name, email and phone come from
// the user record; dietary restrictions and accessibility requirements from
// attendee_profile. The table is reached only through its database functions,
// which re-check that the user is an active ATTENDEE.
const supabase = require("../config/supabase");

// Raised by the database functions; each becomes a stable API code.
const PROFILE_ERRORS = new Set(["NOT_ATTENDEE", "STALE_PROFILE"]);

const attendeeProfileError = (code) => {
  const error = new Error(code);
  error.name = "AttendeeProfileError";
  error.code = code;
  return error;
};

const toProfileError = (error) =>
  error.code === "P0001" && PROFILE_ERRORS.has(error.message)
    ? attendeeProfileError(error.message)
    : new Error(`[Supabase Error] ${error.message}`);

// attendeeId and version are null until the first save.
const toAttendeeProfile = (row) => ({
  attendeeId: row.attendee_id,
  userId: row.user_id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  dietaryRestrictions: row.dietary_restrictions,
  accessibilityRequirements: row.accessibility_requirements,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Throws NOT_ATTENDEE when the user is not an active ATTENDEE. Event
// Registration (SPM-134) reads attendee details through this function.
const findAttendeeProfile = async (userId) => {
  const { data, error } = await supabase.rpc("get_attendee_profile", { p_user_id: userId });
  if (error) throw toProfileError(error);
  if (!data) throw attendeeProfileError("NOT_ATTENDEE");
  return toAttendeeProfile(data);
};

// Creates the profile when version is null, otherwise updates it if the
// version still matches. Returns { profile, created }.
const saveAttendeeProfile = async (userId, { dietaryRestrictions, accessibilityRequirements, version }) => {
  const { data, error } = await supabase.rpc("save_attendee_profile", {
    p_user_id: userId,
    p_dietary_restrictions: dietaryRestrictions,
    p_accessibility_requirements: accessibilityRequirements,
    p_expected_version: version,
  });
  if (error) throw toProfileError(error);
  if (!data || !data.profile) throw new Error("save_attendee_profile returned no profile.");
  return { profile: toAttendeeProfile(data.profile), created: data.created === true };
};

module.exports = { findAttendeeProfile, saveAttendeeProfile };
