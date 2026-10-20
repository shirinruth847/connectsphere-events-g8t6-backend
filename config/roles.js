// Values must match the public.user_role enum exactly.
const USER_ROLES = Object.freeze({
  ORGANISER: "ORGANISER",
  COORDINATOR: "COORDINATOR",
  COORDINATOR_LEAD: "COORDINATOR_LEAD",
  VENUE_STAFF: "VENUE_STAFF",
  TECH_SUPPORT: "TECH_SUPPORT",
  SAFETY_OFFICER: "SAFETY_OFFICER",
  ATTENDEE: "ATTENDEE",
});

// Landing page after login (Master section 3.4). /dashboard renders the
// role-specific workspace; attendees land on their own registrations. The
// Safety Officer also works from /dashboard (SPM-243 AC1); the Master still
// lists that home as not implemented.
const ROLE_HOME_PATHS = Object.freeze({
  ORGANISER: "/dashboard",
  COORDINATOR: "/dashboard",
  COORDINATOR_LEAD: "/dashboard",
  VENUE_STAFF: "/dashboard",
  TECH_SUPPORT: "/dashboard",
  SAFETY_OFFICER: "/dashboard",
  ATTENDEE: "/my-registrations",
});

module.exports = { USER_ROLES, ROLE_HOME_PATHS };
