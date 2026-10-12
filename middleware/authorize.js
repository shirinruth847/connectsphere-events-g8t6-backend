const { UNAUTHENTICATED } = require("./auth");
const { USER_ROLES } = require("../config/roles");
const {
  EVENT_STATUS,
  EVENT_RELATIONSHIP,
  HISTORY_AUDIENCE,
  EVENT_FIELD_GROUPS,
  OWNER_DRAFT_FIELDS,
  COORDINATOR_EDITABLE_STATUSES,
} = require("../config/eventConstants");

// History audiences each relationship may read (SPM-33 AC8). Only the owner sees
// entries from before submission: nobody else could see the draft, so nobody else
// may read what it used to say. Staff-only entries never reach organisers.
const HISTORY_AUDIENCES = Object.freeze({
  [EVENT_RELATIONSHIP.OWNER]: Object.freeze([HISTORY_AUDIENCE.OWNER_ONLY, HISTORY_AUDIENCE.ORGANISER_SAFE]),
  [EVENT_RELATIONSHIP.ORGANISATION_MEMBER]: Object.freeze([HISTORY_AUDIENCE.ORGANISER_SAFE]),
  [EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR]: Object.freeze([HISTORY_AUDIENCE.ORGANISER_SAFE, HISTORY_AUDIENCE.STAFF_ONLY]),
});

const FORBIDDEN = { error: "You do not have permission to access this resource.", code: "FORBIDDEN" };

// Usage: requireRole("ORGANISER") or requireRole("COORDINATOR", "ORGANISER").
// Must run after requireAuth, which loads the trusted role from the database.
const requireRole = (...allowedRoles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json(UNAUTHENTICATED);
  }
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json(FORBIDDEN);
  }
  return next();
};

// Returns null when the event is outside the user's viewing scope. Each role is
// judged only by its own relationship: a coordinator's role says nothing about
// events they are not assigned to, and other roles have no scope through this view.
const getEventRelationship = (user, event) => {
  if (user.role === USER_ROLES.ORGANISER) {
    if (event.organiser_id === user.user_id) return EVENT_RELATIONSHIP.OWNER;
    const sameOrganisation =
      event.organisation_id != null && (user.organisation_ids || []).includes(event.organisation_id);
    return sameOrganisation && event.status !== EVENT_STATUS.DRAFT ? EVENT_RELATIONSHIP.ORGANISATION_MEMBER : null;
  }
  if (user.role === USER_ROLES.COORDINATOR) {
    const isAssigned = event.coordinator_id != null && event.coordinator_id === user.user_id;
    return isAssigned && event.status !== EVENT_STATUS.DRAFT ? EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR : null;
  }
  return null;
};

// The SPM-33 field edit matrix for one user and one event row.
const getEventAccess = (user, event) => {
  const relationship = getEventRelationship(user, event);
  let editableFields = [];
  if (relationship === EVENT_RELATIONSHIP.OWNER && event.status === EVENT_STATUS.DRAFT) {
    editableFields = OWNER_DRAFT_FIELDS;
  } else if (
    relationship === EVENT_RELATIONSHIP.ASSIGNED_COORDINATOR &&
    COORDINATOR_EDITABLE_STATUSES.includes(event.status)
  ) {
    editableFields = EVENT_FIELD_GROUPS.ORDINARY;
  }
  return {
    relationship,
    canEdit: editableFields.length > 0,
    editableFields: [...editableFields],
    historyAudiences: [...(HISTORY_AUDIENCES[relationship] || [])],
  };
};

module.exports = { requireRole, getEventRelationship, getEventAccess };
