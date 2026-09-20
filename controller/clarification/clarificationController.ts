/**
 * SUBTASK 7: ClarificationController
 * Handles HTTP requests for clarification endpoints
 */

import { Request, Response, NextFunction } from 'express';
import {
  clarificationService,
  ValidationError,
  NotFoundError,
  ForbiddenError
} from '@/services/clarification/ClarificationService';

import { auditService } from '@/services/audit/AuditService';

/**
 * ClarificationController
 * All HTTP handlers for clarification requests
 */
export class ClarificationController {
  /**
   * POST /api/events/:eventId/clarification-requests
   * Coordinator submits a clarification request
   * 
   * Body: { "message": "Clarification message..." }
   * Headers: x-coordinator-id (coordinator's user ID)
   * 
   * Returns 201 on success
   */
  static async submitClarificationRequest(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { eventId } = req.params;
      const { message } = req.body;

      // Get coordinator ID from authenticated user (mock: from headers)
      const coordinatorId = req.headers['x-coordinator-id'] as string;

      if (!coordinatorId) {
        res.status(403).json({
          code: 'UNAUTHORIZED',
          message: 'Coordinator ID required in x-coordinator-id header'
        });
        return;
      }

      if (!message) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'Message is required'
        });
        return;
      }

      // Call service to submit clarification
      const clarification = await clarificationService.submitClarificationRequest(
        eventId,
        coordinatorId,
        message
      );

      // Log to audit trail
      await auditService.logClarificationRequest(eventId, coordinatorId, message);

      // Success response
      res.status(201).json({
        success: true,
        data: {
          clarificationId: clarification.id,
          eventId: clarification.event_id,
          coordinatorId: clarification.coordinator_id,
          message: clarification.message,
          status: clarification.status,
          createdAt: clarification.created_at
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/events/:eventId/clarification-requests
   * Organiser or Coordinator views clarifications for an event
   * 
   * Returns 200 with list of clarifications
   */
  static async getEventClarifications(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { eventId } = req.params;
      const userId = req.headers['x-user-id'] as string;

      if (!userId) {
        res.status(403).json({
          code: 'UNAUTHORIZED',
          message: 'User ID required in x-user-id header'
        });
        return;
      }

      // Get clarifications
      const clarifications = await clarificationService.getEventClarifications(eventId);

      // Success response
      res.status(200).json({
        success: true,
        data: {
          eventId,
          clarifications,
          count: clarifications.length
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/events/:eventId/clarification-requests/:clarificationId
   * Get details of a specific clarification request
   * 
   * Returns 200 with clarification details
   */
  static async getClarificationById(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { clarificationId } = req.params;

      // Get clarification
      const clarification = await clarificationService.getClarificationById(
        clarificationId
      );

      // Success response
      res.status(200).json({
        success: true,
        data: clarification
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/events/:eventId/clarification-history
   * Organiser views audit trail of clarifications for an event
   * 
   * Returns 200 with audit trail
   */
  static async getClarificationHistory(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { eventId } = req.params;

      // Get audit trail
      const trail = await auditService.getEventAuditTrail(eventId);

      // Success response
      res.status(200).json({
        success: true,
        data: {
          eventId,
          trail: trail.entries,
          totalCount: trail.totalCount
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/events/:eventId/can-request-venue
   * Check if event is blocked from requesting venue (Subtask 6 function)
   * 
   * Returns 200 with boolean and reason
   */
  static async checkVenueBookingBlocked(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { eventId } = req.params;

      // Check if blocked
      const isBlocked = await clarificationService.isEventBlockedFromVenueBooking(eventId);

      // Success response
      res.status(200).json({
        success: true,
        data: {
          eventId,
          canRequest: !isBlocked,
          isBlocked,
          reason: isBlocked
            ? 'Event is waiting for clarification - venue booking blocked'
            : 'Event can proceed with venue booking'
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/events/:eventId/can-request-equipment
   * Check if event is blocked from requesting equipment (Subtask 6 function)
   * 
   * Returns 200 with boolean and reason
   */
  static async checkEquipmentBlocked(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { eventId } = req.params;

      // Check if blocked
      const isBlocked = await clarificationService.isEventBlockedFromEquipment(eventId);

      // Success response
      res.status(200).json({
        success: true,
        data: {
          eventId,
          canRequest: !isBlocked,
          isBlocked,
          reason: isBlocked
            ? 'Event is waiting for clarification - equipment request blocked'
            : 'Event can proceed with equipment request'
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/events/:eventId/can-request-tech-support
   * Check if event is blocked from requesting tech support (Subtask 6 function)
   * 
   * Returns 200 with boolean and reason
   */
  static async checkTechSupportBlocked(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { eventId } = req.params;

      // Check if blocked
      const isBlocked = await clarificationService.isEventBlockedFromTechSupport(eventId);

      // Success response
      res.status(200).json({
        success: true,
        data: {
          eventId,
          canRequest: !isBlocked,
          isBlocked,
          reason: isBlocked
            ? 'Event is waiting for clarification - tech support request blocked'
            : 'Event can proceed with tech support request'
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * SUBTASK 10: PUT /api/events/:eventId/resubmit
   * Organiser resubmits event after clarification
   */
  static async resubmitEvent(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { eventId } = req.params;
      const { updatedEventData } = req.body;
      const organiserId = req.headers['x-organiser-id'] as string;
 
      if (!organiserId) {
        res.status(403).json({
          code: 'UNAUTHORIZED',
          message: 'Organiser ID required in x-organiser-id header'
        });
        return;
      }
 
      // Resubmit event
      const updatedEvent = await clarificationService.resubmitEvent(
        eventId,
        organiserId,
        updatedEventData
      );
 
      // Log to audit trail
      await auditService.logEventResubmission(eventId, organiserId);
 
      // Success response
      res.status(200).json({
        success: true,
        data: {
          eventId,
          status: updatedEvent.status,
          message: 'Event resubmitted for review',
          resubmittedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      next(error);
    }
  }

  static async getAllClarifications(
    req: Request,
    res: Response,
    next: NextFunction
    ): Promise<void> {
    try {
        const clarifications = await clarificationService.getAllClarifications();

        res.status(200).json({
        success: true,
        data: {
            clarifications,
            count: clarifications.length
        }
        });
    } catch (error) {
        next(error);
    }
    }
}