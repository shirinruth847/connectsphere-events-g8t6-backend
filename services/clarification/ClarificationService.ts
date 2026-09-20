/**
 * SUBTASK 3: ClarificationService
 * Handles all business logic for clarification requests
 */

import {
  ClarificationRequest,
  ClarificationRequestStatus,
  CreateClarificationRequestInput,
  ClarificationValidationErrors,
  Event
} from '@/database/types';

import {
  getAllClarificationRequests,
  getClarificationRequestsByEventId,
  createMockClarificationRequest,
  updateMockClarificationRequestStatus,
  getClarificationRequestById,
  updateMockEvent
} from '@/database/mock';

import {
  getEventById,
  updateMockEventStatus
} from '@/database/mock';

import { EventStatus } from '@/database/types';
import { AuditLog } from '@/database/types';
import { notificationService } from '@/services/notification/NotificationService';
import { auditService } from '@/services/audit/AuditService';

/**
 * Custom Error Classes
 */
export class ValidationError extends Error {
  code: string;
  constructor(message: string, code: string = 'VALIDATION_ERROR') {
    super(message);
    this.code = code;
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  code: string;
  constructor(message: string) {
    super(message);
    this.code = 'NOT_FOUND';
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  code: string;
  constructor(message: string) {
    super(message);
    this.code = 'UNAUTHORIZED';
    this.name = 'ForbiddenError';
  }
}

/**
 * ClarificationService Class
 * All business logic for handling clarification requests
 */
export class ClarificationService {
  /**
   * Validates clarification request message
   * Must be 10-500 characters
   */
  private validateMessage(message: string): void {
    if (!message || typeof message !== 'string') {
      throw new ValidationError(
        ClarificationValidationErrors.EMPTY_MESSAGE,
        'EMPTY_MESSAGE'
      );
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage.length < 10) {
      throw new ValidationError(
        ClarificationValidationErrors.MESSAGE_TOO_SHORT,
        'MESSAGE_TOO_SHORT'
      );
    }

    if (message.length > 500) {
      throw new ValidationError(
        ClarificationValidationErrors.MESSAGE_TOO_LONG,
        'MESSAGE_TOO_LONG'
      );
    }
  }

  /**
   * Validates event and coordinator IDs
   */
  private validateEvent(eventId: string, coordinatorId: string): void {
    if (!eventId || eventId.trim().length === 0) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_ID,
        'INVALID_EVENT_ID'
      );
    }

    if (!coordinatorId || coordinatorId.trim().length === 0) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_COORDINATOR_ID,
        'INVALID_COORDINATOR_ID'
      );
    }
  }

  /**
   * SUBTASK 5: Submit clarification request
   * Main business logic for requesting clarification
   */
  async submitClarificationRequest(
    eventId: string,
    coordinatorId: string,
    message: string
  ): Promise<ClarificationRequest> {
    // 1. Validate inputs
    this.validateMessage(message);
    this.validateEvent(eventId, coordinatorId);

    // 2. Check event exists
    const event = getEventById(eventId);
    if (!event) {
      throw new NotFoundError('Event not found');
    }

    // 3. Check if coordinator is assigned to event
    if (event.coordinator_id !== coordinatorId) {
      throw new ForbiddenError('Coordinator is not assigned to this event');
    }

    // 4. Check event is in SUBMITTED status
    if (event.status !== EventStatus.SUBMITTED) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_STATUS,
        'INVALID_EVENT_STATUS'
      );
    }

    try {
      // 5. Create clarification request
      const clarification = createMockClarificationRequest(
        eventId,
        coordinatorId,
        message
      );

      // 6. Update event status to RETURNED_FOR_CLARIFICATION
      updateMockEventStatus(eventId, EventStatus.RETURNED_FOR_CLARIFICATION);

      // 7. Log audit trail (will be called from controller)
      // AuditService handles this - see Subtask 4

      // 8. Trigger notification (Subtask 11)
      await notificationService.notifyClarificationRequested(
        event.organiser_id,
        eventId,
        coordinatorId,
        message
      );

      return clarification;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to submit clarification request: ${errorMessage}`);
    }
  }

  /**
   * SUBTASK 6: Check if event is blocked from venue booking
   */
  async isEventBlockedFromVenueBooking(eventId: string): Promise<boolean> {
    if (!eventId) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_ID,
        'INVALID_EVENT_ID'
      );
    }

    const event = getEventById(eventId);
    if (!event) {
      throw new NotFoundError('Event not found');
    }

    return event.status === EventStatus.RETURNED_FOR_CLARIFICATION;
  }

  /**
   * SUBTASK 6: Check if event is blocked from equipment request
   */
  async isEventBlockedFromEquipment(eventId: string): Promise<boolean> {
    if (!eventId) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_ID,
        'INVALID_EVENT_ID'
      );
    }

    const event = getEventById(eventId);
    if (!event) {
      throw new NotFoundError('Event not found');
    }

    return event.status === EventStatus.RETURNED_FOR_CLARIFICATION;
  }

  /**
   * SUBTASK 6: Check if event is blocked from tech support request
   */
  async isEventBlockedFromTechSupport(eventId: string): Promise<boolean> {
    if (!eventId) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_ID,
        'INVALID_EVENT_ID'
      );
    }

    const event = getEventById(eventId);
    if (!event) {
      throw new NotFoundError('Event not found');
    }

    return event.status === EventStatus.RETURNED_FOR_CLARIFICATION;
  }

  /**
   * Get all clarifications for an event
   */
  async getEventClarifications(eventId: string): Promise<ClarificationRequest[]> {
    if (!eventId) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_ID,
        'INVALID_EVENT_ID'
      );
    }

    return getClarificationRequestsByEventId(eventId);
  }

  /**
   * Get single clarification by ID
   */
  async getClarificationById(id: string): Promise<ClarificationRequest> {
    if (!id) {
      throw new NotFoundError('Clarification not found');
    }

    const clarification = getClarificationRequestById(id);
    if (!clarification) {
      throw new NotFoundError('Clarification not found');
    }

    return clarification;
  }

  /**
   * Get all clarifications
   */
  async getAllClarifications(): Promise<ClarificationRequest[]> {
    return getAllClarificationRequests();
  }

  /**
   * SUBTASK 8: Get clarification history/audit trail for event
   * Timeline of clarification requests and resubmissions
   */
  async getClarificationHistory(eventId: string): Promise<AuditLog[]> {
    if (!eventId) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_ID,
        'INVALID_EVENT_ID'
      );
    }
 
    // Get audit trail from AuditService
    const trail = await auditService.getEventAuditTrail(eventId);
    return trail.entries;
  }

  /**
   * SUBTASK 10: Resubmit event after clarification
   * Organiser edits event and resubmits it in response to clarification
   */
  async resubmitEvent(
    eventId: string,
    organiserId: string,
    updatedEventData?: Partial<Event>
  ): Promise<Event> {
    if (!eventId) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_ID,
        'INVALID_EVENT_ID'
      );
    }
 
    if (!organiserId) {
      throw new ValidationError(
        ClarificationValidationErrors.INVALID_EVENT_ID,
        'INVALID_EVENT_ID'
      );
    }
 
    // 1. Check event exists and is in RETURNED_FOR_CLARIFICATION status
    const event = getEventById(eventId);
    if (!event) {
      throw new NotFoundError('Event not found');
    }
 
    if (event.status !== EventStatus.RETURNED_FOR_CLARIFICATION) {
      throw new ValidationError(
        'Event must be in RETURNED_FOR_CLARIFICATION status to resubmit',
        'INVALID_EVENT_STATUS'
      );
    }
 
    // 2. Check organiser owns the event
    if (event.organiser_id !== organiserId) {
      throw new ForbiddenError('Organiser does not own this event');
    }
 
    try {
      // 3. Update event with any changes
      if (updatedEventData) {
        updateMockEvent(eventId, updatedEventData);
      }
 
      // 4. Update event status back to SUBMITTED
      updateMockEventStatus(eventId, EventStatus.SUBMITTED);
 
      // 5. Log audit trail
      await auditService.logEventResubmission(eventId, organiserId);
 
      // 6. Mark all pending clarifications as responded
      const clarifications = getClarificationRequestsByEventId(eventId);
      clarifications.forEach(clr => {
        if (clr.status === ClarificationRequestStatus.PENDING) {
          updateMockClarificationRequestStatus(
            clr.id,
            ClarificationRequestStatus.RESPONDED
          );
        }
      });
 
      // 7. Trigger notification (Subtask 11)
      await notificationService.notifyEventResubmitted(
        event.coordinator_id || 'unknown',
        eventId,
        event.organiser_id
      );
 
      // 8. Return updated event
      const updatedEvent = getEventById(eventId);
      if (!updatedEvent) {
        throw new Error('Failed to retrieve updated event');
      }
 
      return updatedEvent;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof NotFoundError || error instanceof ForbiddenError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to resubmit event: ${errorMessage}`);
    }
  }
}

// Export singleton instance
export const clarificationService = new ClarificationService();