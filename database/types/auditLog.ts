/**
 * SUBTASK 4: AuditLog Types
 * TypeScript interfaces and types for audit logging
 */

/**
 * AuditAction enum
 * Represents types of actions that are logged
 */
export enum AuditAction {
  CLARIFICATION_REQUESTED = 'CLARIFICATION_REQUESTED',
  EVENT_RESUBMITTED = 'EVENT_RESUBMITTED',
}

/**
 * AuditLog interface
 * Represents a single immutable audit log entry
 */
export interface AuditLog {
  id: string;                              // UUID
  event_id: string;                        // Reference to event
  action: AuditAction;                     // Type of action
  user_id: string;                         // User who performed action (coordinator or organiser)
  message: string;                         // Description of action
  metadata?: Record<string, any>;          // Optional additional data
  created_at: Date;                        // Timestamp (immutable)
}

/**
 * CreateAuditLogInput
 * Input for creating a new audit log entry
 */
export interface CreateAuditLogInput {
  event_id: string;
  action: AuditAction;
  user_id: string;
  message: string;
  metadata?: Record<string, any>;
}

/**
 * AuditLogResponse
 * Response object from API endpoints
 */
export interface AuditLogResponse {
  id: string;
  event_id: string;
  action: AuditAction;
  user_id: string;
  message: string;
  metadata?: Record<string, any>;
  created_at: Date;
}

/**
 * AuditTrail
 * Collection of related audit logs (timeline)
 */
export interface AuditTrail {
  eventId: string;
  entries: AuditLog[];
  totalCount: number;
}