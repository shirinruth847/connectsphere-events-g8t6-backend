// SPM-270 attendee profile model: maps the database functions' rows and
// refusals. Only the Supabase client is mocked.
jest.mock("../../config/supabase", () => ({ rpc: jest.fn() }));

const supabase = require("../../config/supabase");
const { findAttendeeProfile, saveAttendeeProfile } = require("../../model/attendeeProfileModel");

const ROW = {
  attendee_id: 5,
  user_id: 21,
  name: "Attendee A",
  email: "a@example.test",
  phone: "+65 8000 0001",
  dietary_restrictions: "Vegan",
  accessibility_requirements: null,
  version: 3,
  created_at: "2026-10-24T01:00:00+00:00",
  updated_at: "2026-10-24T02:00:00+00:00",
};
const PROFILE = {
  attendeeId: 5,
  userId: 21,
  name: "Attendee A",
  email: "a@example.test",
  phone: "+65 8000 0001",
  dietaryRestrictions: "Vegan",
  accessibilityRequirements: null,
  version: 3,
  createdAt: "2026-10-24T01:00:00+00:00",
  updatedAt: "2026-10-24T02:00:00+00:00",
};
const raised = (message) => ({ data: null, error: { code: "P0001", message } });

beforeEach(() => jest.clearAllMocks());

describe("findAttendeeProfile (SPM-270)", () => {
  test("[TC-PROFILE-001] should_combine_the_user_record_with_the_profile_when_the_attendee_has_one", async () => {
    supabase.rpc.mockResolvedValue({ data: ROW, error: null });
    await expect(findAttendeeProfile(21)).resolves.toEqual(PROFILE);
    expect(supabase.rpc).toHaveBeenCalledWith("get_attendee_profile", { p_user_id: 21 });
  });

  test("[TC-PROFILE-012] should_return_only_the_allowlisted_fields_when_the_row_has_extra_columns", async () => {
    supabase.rpc.mockResolvedValue({ data: { ...ROW, auth_user_id: "uuid", role: "ATTENDEE", is_active: true }, error: null });
    expect(Object.keys(await findAttendeeProfile(21)).sort()).toEqual(Object.keys(PROFILE).sort());
  });

  test("[TC-PROFILE-003] should_throw_not_attendee_when_the_user_is_not_an_active_attendee", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: null });
    await expect(findAttendeeProfile(21)).rejects.toMatchObject({ name: "AttendeeProfileError", code: "NOT_ATTENDEE" });
  });

  test("[TC-PROFILE-010] should_throw_and_never_return_a_profile_when_the_database_fails", async () => {
    supabase.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement" } });
    await expect(findAttendeeProfile(21)).rejects.toThrow("[Supabase Error] canceling statement");
  });
});

describe("saveAttendeeProfile (SPM-270)", () => {
  const input = { dietaryRestrictions: "Vegan", accessibilityRequirements: null, version: 2 };

  test("[TC-PROFILE-006] should_pass_only_the_trusted_user_id_and_validated_fields_when_saving", async () => {
    supabase.rpc.mockResolvedValue({ data: { created: false, profile: ROW }, error: null });
    await expect(saveAttendeeProfile(21, input)).resolves.toEqual({ profile: PROFILE, created: false });
    expect(supabase.rpc).toHaveBeenCalledWith("save_attendee_profile", {
      p_user_id: 21,
      p_dietary_restrictions: "Vegan",
      p_accessibility_requirements: null,
      p_expected_version: 2,
    });
  });

  test("[TC-PROFILE-004] should_report_created_when_the_database_created_the_profile", async () => {
    supabase.rpc.mockResolvedValue({ data: { created: true, profile: { ...ROW, version: 1 } }, error: null });
    await expect(saveAttendeeProfile(21, { ...input, version: null })).resolves.toMatchObject({ created: true });
  });

  test.each(["NOT_ATTENDEE", "STALE_PROFILE"])("[TC-PROFILE-005] should_map_the_database_refusal_%s_to_a_domain_error", async (code) => {
    supabase.rpc.mockResolvedValue(raised(code));
    await expect(saveAttendeeProfile(21, input)).rejects.toMatchObject({ name: "AttendeeProfileError", code });
  });

  test("[TC-PROFILE-010] should_treat_unknown_refusals_and_missing_rows_as_failures_when_saving", async () => {
    supabase.rpc.mockResolvedValue(raised("SOMETHING_ELSE"));
    await expect(saveAttendeeProfile(21, input)).rejects.toThrow("[Supabase Error] SOMETHING_ELSE");
    supabase.rpc.mockResolvedValue({ data: { created: true }, error: null });
    await expect(saveAttendeeProfile(21, input)).rejects.toThrow("returned no profile");
  });
});
