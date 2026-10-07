const supabase = require("../config/supabase");

const EVENT_REQUEST_COLUMNS =
  "event_id, title, status, start_datetime, end_datetime, expected_attendance, organiser_id, created_at, updated_at, organisation(organisation_id, name)";

// An organiser sees their own requests in any state, plus requests from their
// verified organisations once submitted (Master section 4.2: same-organisation
// visibility begins after submission).
const buildOrganiserVisibilityFilter = (user) => {
  const ownRequests = `organiser_id.eq.${Number(user.user_id)}`;
  const organisationIds = user.organisation_ids.map(Number).filter(Number.isInteger);

  if (organisationIds.length === 0) {
    return ownRequests;
  }
  return `${ownRequests},and(organisation_id.in.(${organisationIds.join(",")}),status.neq.DRAFT)`;
};

// Fetches one extra row to tell whether another page exists. event_id breaks
// ties between equal timestamps so pages stay stable.
const findOrganiserEventRequests = async (user, { limit, offset }) => {
  const { data, error } = await supabase
    .from("event")
    .select(EVENT_REQUEST_COLUMNS)
    .or(buildOrganiserVisibilityFilter(user))
    .order("created_at", { ascending: false })
    .order("event_id", { ascending: false })
    .range(offset, offset + limit);

  if (error) {
    throw new Error(`[Supabase Error] ${error.message}`);
  }

  // organiser_id identifies another person, so only ownership is exposed.
  const events = data.slice(0, limit).map(({ organiser_id, ...event }) => ({
    ...event,
    is_owner: organiser_id === user.user_id,
  }));

  return { events, nextOffset: data.length > limit ? offset + limit : null };
};

module.exports = { findOrganiserEventRequests, buildOrganiserVisibilityFilter };
