const { UNAUTHENTICATED } = require("./auth");
const { parseEventId } = require("./validate");
const eventModel = require("../model/eventModel");
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

const CLOSED_STATUSES = [EVENT_STATUS.COMPLETED, EVENT_STATUS.REJECTED, EVENT_STATUS.CANCELLED];

const FORBIDDEN = { error: "You do not have permission to access this resource.", code: "FORBIDDEN" };
const EVENT_NOT_FOUND = { error: "Event request not found.", code: "EVENT_NOT_FOUND" };

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

// Why a user who can see the event cannot edit it at all, as the error code to
// answer with, or null when they can.
const getEditDenial = (access, event) => {
  if (access.canEdit) return null;
  if (access.relationship === EVENT_RELATIONSHIP.ORGANISATION_MEMBER) return "EVENT_READ_ONLY";
  if (access.relationship === EVENT_RELATIONSHIP.OWNER && !CLOSED_STATUSES.includes(event.status)) {
    return "EDIT_REQUIRES_CHANGE_REQUEST";
  }
  return "EVENT_NOT_EDITABLE_IN_STATUS";
};

// The event and what this user may do with it, or null when it is outside their
// viewing scope. Callers answer "not found" for null, never "forbidden", so the
// response does not confirm that the event exists (SPM-33 AC1, AC6).
const loadEventForViewer = async (eventId, user) => {
  const event = await eventModel.findVisibleEvent(eventId, user);
  if (!event) return null;
  const access = getEventAccess(user, event);
  return access.relationship ? { event, access } : null;
};

// Must run after requireAuth. Loads the event named by ":id" for the signed-in
// user and answers "not found" unless it is inside their viewing scope, so the
// handlers after it only ever see events the user may see. Sets
// req.visibleEvent = { eventId, event, access }.
const requireVisibleEvent = async (req, res, next) => {
  try {
    const eventId = parseEventId(req.params.id);
    const visible = eventId ? await loadEventForViewer(eventId, req.user) : null;
    if (!visible) {
      return res.status(404).json(EVENT_NOT_FOUND);
    }
    req.visibleEvent = { eventId, ...visible };
    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  requireRole,
  requireVisibleEvent,
  loadEventForViewer,
  getEventRelationship,
  getEventAccess,
  getEditDenial,
  EVENT_NOT_FOUND,
};
