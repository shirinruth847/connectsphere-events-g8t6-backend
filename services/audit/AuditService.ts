/**
 * SUBTASK 4: AuditService
 * Handles creation and retrieval of audit logs
 */

import {
  AuditLog,
  AuditAction,
  CreateAuditLogInput,
  AuditTrail
} from '@/database/types';

import {
  createAuditLog,
  getAuditLogsByEventId,
  getAuditLogsByAction,
  getAuditLogsByEventAndAction,
  getAuditLogById
} from '@/database/mock';

/**
 * AuditService Class
 * Manages audit logging for clarification requests
 */
export class AuditService {
  /**
   * Log a clarification request
   * Called when coordinator submits clarification
   */
  async logClarificationRequest(
    eventId: string,
    coordinatorId: string,
    message: string
  ): Promise<AuditLog> {
    return createAuditLog({
      event_id: eventId,
      action: AuditAction.CLARIFICATION_REQUESTED,
      user_id: coordinatorId,
      message: message,
      metadata: {
        message_length: message.length,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Log an event resubmission
   * Called when organiser resubmits event after clarification
   */
  async logEventResubmission(
    eventId: string,
    organiserId: string,
    changes?: string
  ): Promise<AuditLog> {
    return createAuditLog({
      event_id: eventId,
      action: AuditAction.EVENT_RESUBMITTED,
      user_id: organiserId,
      message: 'Event resubmitted in response to clarification request',
      metadata: {
        changes: changes || 'None documented',
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Get complete audit trail for an event
   */
  async getEventAuditTrail(eventId: string): Promise<AuditTrail> {
    const entries = getAuditLogsByEventId(eventId);
    return {
      eventId,
      entries,
      totalCount: entries.length
    };
  }

  /**
   * Get clarification requests for an event (audit logs)
   */
  async getClarificationAuditTrail(eventId: string): Promise<AuditLog[]> {
    return getAuditLogsByEventAndAction(
      eventId,
      AuditAction.CLARIFICATION_REQUESTED
    );
  }

  /**
   * Get resubmission events for an event (audit logs)
   */
  async getResubmissionAuditTrail(eventId: string): Promise<AuditLog[]> {
    return getAuditLogsByEventAndAction(
      eventId,
      AuditAction.EVENT_RESUBMITTED
    );
  }

  /**
   * Get all clarification requests across all events (coordinator view)
   */
  async getAllClarificationRequests(): Promise<AuditLog[]> {
    return getAuditLogsByAction(AuditAction.CLARIFICATION_REQUESTED);
  }

  /**
   * Get all clarifications made by a specific coordinator
   */
  async getClarificationsByCoordinator(coordinatorId: string): Promise<AuditLog[]> {
    const allClarifications = getAuditLogsByAction(AuditAction.CLARIFICATION_REQUESTED);
    return allClarifications.filter(log => log.user_id === coordinatorId);
  }

  /**
   * Get single audit log by ID
   */
  async getAuditLogById(id: string): Promise<AuditLog | undefined> {
    return getAuditLogById(id);
  }

  /**
   * Count clarifications for an event
   */
  async countClarifications(eventId: string): Promise<number> {
    const trail = await this.getClarificationAuditTrail(eventId);
    return trail.length;
  }

  /**
   * Check if event has any clarifications
   */
  async hasClarifications(eventId: string): Promise<boolean> {
    const count = await this.countClarifications(eventId);
    return count > 0;
  }
}

// Export singleton instance
export const auditService = new AuditService();