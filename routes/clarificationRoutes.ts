/**
 * SUBTASK 7: Clarification Routes
 * Express.js routes for all clarification endpoints
 */

import { Router } from 'express';
import { ClarificationController } from '../controllers/clarification/clarificationController';

const router = Router();

/**
 * SUBTASK 7: POST /api/events/:eventId/clarification-requests
 * Submit a clarification request
 * Coordinator submits a request asking organiser for clarification
 * 
 * Request Headers:
 *   x-coordinator-id: The coordinator's user ID
 * 
 * Request Body:
 *   {
 *     "message": "Clarification message (10-500 chars)"
 *   }
 * 
 * Success Response: 201 Created
 *   {
 *     "success": true,
 *     "data": {
 *       "clarificationId": "clr_xxx",
 *       "eventId": "evt_xxx",
 *       "coordinatorId": "coord_xxx",
 *       "message": "...",
 *       "status": "PENDING",
 *       "createdAt": "2025-09-12T10:30:00Z"
 *     }
 *   }
 * 
 * Error Responses:
 *   400: VALIDATION_ERROR - Message invalid (empty, too short/long)
 *   403: UNAUTHORIZED - No coordinator ID or not assigned to event
 *   404: NOT_FOUND - Event doesn't exist
 */
router.post(
  '/events/:eventId/clarification-requests',
  ClarificationController.submitClarificationRequest
);

/**
 * GET /api/events/:eventId/clarification-requests
 * View all clarifications for an event
 * Organiser can see clarifications for their event
 * Coordinator can see clarifications they sent
 * 
 * Request Headers:
 *   x-user-id: The user's ID (for permission check)
 * 
 * Success Response: 200 OK
 *   {
 *     "success": true,
 *     "data": {
 *       "eventId": "evt_xxx",
 *       "clarifications": [
 *         {
 *           "id": "clr_001",
 *           "event_id": "evt_xxx",
 *           "coordinator_id": "coord_001",
 *           "message": "...",
 *           "status": "PENDING",
 *           "created_at": "2025-09-12T10:30:00Z",
 *           "updated_at": "2025-09-12T10:30:00Z"
 *         }
 *       ],
 *       "count": 1
 *     }
 *   }
 * 
 * Error Responses:
 *   403: UNAUTHORIZED - No user ID
 *   404: NOT_FOUND - Event doesn't exist
 */
router.get(
  '/events/:eventId/clarification-requests',
  ClarificationController.getEventClarifications
);

/**
 * GET /api/events/:eventId/clarification-requests/:clarificationId
 * View details of a specific clarification request
 * 
 * Success Response: 200 OK
 *   {
 *     "success": true,
 *     "data": {
 *       "id": "clr_001",
 *       "event_id": "evt_xxx",
 *       "coordinator_id": "coord_001",
 *       "message": "...",
 *       "status": "PENDING",
 *       "created_at": "2025-09-12T10:30:00Z",
 *       "updated_at": "2025-09-12T10:30:00Z"
 *     }
 *   }
 * 
 * Error Responses:
 *   404: NOT_FOUND - Clarification doesn't exist
 */
router.get(
  '/events/:eventId/clarification-requests/:clarificationId',
  ClarificationController.getClarificationById
);

/**
 * GET /api/events/:eventId/clarification-history
 * View audit trail of all clarifications for an event
 * Shows timeline of clarification requests and resubmissions
 * 
 * Success Response: 200 OK
 *   {
 *     "success": true,
 *     "data": {
 *       "eventId": "evt_xxx",
 *       "trail": [
 *         {
 *           "id": "audit_001",
 *           "event_id": "evt_xxx",
 *           "action": "CLARIFICATION_REQUESTED",
 *           "user_id": "coord_001",
 *           "message": "Could you clarify...",
 *           "created_at": "2025-09-12T10:30:00Z"
 *         },
 *         {
 *           "id": "audit_002",
 *           "event_id": "evt_xxx",
 *           "action": "EVENT_RESUBMITTED",
 *           "user_id": "org_001",
 *           "message": "Event resubmitted",
 *           "created_at": "2025-09-12T15:00:00Z"
 *         }
 *       ],
 *       "totalCount": 2
 *     }
 *   }
 * 
 * Error Responses:
 *   404: NOT_FOUND - Event doesn't exist
 */
router.get(
  '/events/:eventId/clarification-history',
  ClarificationController.getClarificationHistory
);

/**
 * POST /api/events/:eventId/can-request-venue
 * Check if venue booking is blocked (Subtask 6 check)
 * Coordinator checks before submitting venue booking request
 * 
 * Success Response: 200 OK
 *   {
 *     "success": true,
 *     "data": {
 *       "eventId": "evt_xxx",
 *       "canRequest": true,
 *       "isBlocked": false,
 *       "reason": "Event can proceed with venue booking"
 *     }
 *   }
 * 
 * Or if blocked:
 *   {
 *     "success": true,
 *     "data": {
 *       "eventId": "evt_xxx",
 *       "canRequest": false,
 *       "isBlocked": true,
 *       "reason": "Event is waiting for clarification - venue booking blocked"
 *     }
 *   }
 * 
 * Error Responses:
 *   404: NOT_FOUND - Event doesn't exist
 */
router.post(
  '/events/:eventId/can-request-venue',
  ClarificationController.checkVenueBookingBlocked
);

/**
 * POST /api/events/:eventId/can-request-equipment
 * Check if equipment request is blocked (Subtask 6 check)
 * Coordinator checks before submitting equipment request
 * 
 * Success Response: 200 OK
 *   {
 *     "success": true,
 *     "data": {
 *       "eventId": "evt_xxx",
 *       "canRequest": true,
 *       "isBlocked": false,
 *       "reason": "Event can proceed with equipment request"
 *     }
 *   }
 * 
 * Or if blocked:
 *   {
 *     "success": true,
 *     "data": {
 *       "eventId": "evt_xxx",
 *       "canRequest": false,
 *       "isBlocked": true,
 *       "reason": "Event is waiting for clarification - equipment request blocked"
 *     }
 *   }
 * 
 * Error Responses:
 *   404: NOT_FOUND - Event doesn't exist
 */
router.post(
  '/events/:eventId/can-request-equipment',
  ClarificationController.checkEquipmentBlocked
);

/**
 * POST /api/events/:eventId/can-request-tech-support
 * Check if tech support request is blocked (Subtask 6 check)
 * Coordinator checks before submitting tech support request
 * 
 * Success Response: 200 OK
 *   {
 *     "success": true,
 *     "data": {
 *       "eventId": "evt_xxx",
 *       "canRequest": true,
 *       "isBlocked": false,
 *       "reason": "Event can proceed with tech support request"
 *     }
 *   }
 * 
 * Or if blocked:
 *   {
 *     "success": true,
 *     "data": {
 *       "eventId": "evt_xxx",
 *       "canRequest": false,
 *       "isBlocked": true,
 *       "reason": "Event is waiting for clarification - tech support request blocked"
 *     }
 *   }
 * 
 * Error Responses:
 *   404: NOT_FOUND - Event doesn't exist
 */
router.post(
  '/events/:eventId/can-request-tech-support',
  ClarificationController.checkTechSupportBlocked
);

/**
 * SUBTASK 9: GET /api/events/:eventId/clarification-requests
 * Get all clarifications for an event
 */
router.get(
  '/events/:eventId/clarification-requests',
  ClarificationController.getEventClarifications
);
 
/**
 * SUBTASK 9: GET /api/events/:eventId/clarification-requests/:clarificationId
 * Get a specific clarification
 */
router.get(
  '/events/:eventId/clarification-requests/:clarificationId',
  ClarificationController.getClarificationById
);
 
/**
 * SUBTASK 9: GET /api/events/:eventId/clarification-history
 * Get audit trail for an event
 */
router.get(
  '/events/:eventId/clarification-history',
  ClarificationController.getClarificationHistory
);
 
/**
 * SUBTASK 9: GET /api/clarifications
 * Get all clarifications (admin/coordinator view)
 */
router.get(
  '/clarifications',
  ClarificationController.getAllClarifications
);
 
/**
 * SUBTASK 10: PUT /api/events/:eventId/resubmit
 * Organiser resubmits event after responding to clarification
 */
router.put(
  '/events/:eventId/resubmit',
  ClarificationController.resubmitEvent
);

export default router;