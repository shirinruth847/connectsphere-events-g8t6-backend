/**
 * SUBTASK 4: Mock AuditLog Data
 * Sample audit logs for local development
 */

import { AuditLog, AuditAction, CreateAuditLogInput } from '../types/auditLog';

/**
 * Mock audit logs
 */
export const mockAuditLogs: AuditLog[] = [
  {
    id: 'audit_001',
    event_id: 'evt_001',
    action: AuditAction.CLARIFICATION_REQUESTED,
    user_id: 'coord_001',
    message: 'Could you please clarify the venue requirements? We need to know the exact seating layout you prefer.',
    created_at: new Date('2025-09-12T10:30:00Z')
  },
  {
    id: 'audit_002',
    event_id: 'evt_001',
    action: AuditAction.EVENT_RESUBMITTED,
    user_id: 'org_001',
    message: 'Event resubmitted with clarified venue requirements - classroom seating layout confirmed for 150 people',
    created_at: new Date('2025-09-12T15:00:00Z')
  },
  {
    id: 'audit_003',
    event_id: 'evt_002',
    action: AuditAction.CLARIFICATION_REQUESTED,
    user_id: 'coord_001',
    message: 'The expected attendance of 200 people may exceed some venue capacities. Can you confirm this number is accurate?',
    created_at: new Date('2025-09-11T14:15:00Z')
  },
  {
    id: 'audit_004',
    event_id: 'evt_003',
    action: AuditAction.CLARIFICATION_REQUESTED,
    user_id: 'coord_002',
    message: 'Please provide more details about the equipment needed. We need to know: speaker count, microphone types, and any special requirements.',
    created_at: new Date('2025-09-12T11:45:00Z')
  },
  {
    id: 'audit_005',
    event_id: 'evt_004',
    action: AuditAction.CLARIFICATION_REQUESTED,
    user_id: 'coord_002',
    message: 'You mentioned accessibility requirements but did not specify if wheelchair access is needed. Can you clarify?',
    created_at: new Date('2025-09-10T16:20:00Z')
  }
];

/**
 * Create a new audit log entry
 */
export const createAuditLog = (input: CreateAuditLogInput): AuditLog => {
  const auditLog: AuditLog = {
    id: `audit_${Date.now()}`,
    event_id: input.event_id,
    action: input.action,
    user_id: input.user_id,
    message: input.message,
    metadata: input.metadata,
    created_at: new Date()
  };

  mockAuditLogs.push(auditLog);
  return auditLog;
};

/**
 * Get all audit logs
 */
export const getAllAuditLogs = (): AuditLog[] => {
  return mockAuditLogs;
};

/**
 * Get audit logs by event ID
 */
export const getAuditLogsByEventId = (eventId: string): AuditLog[] => {
  return mockAuditLogs.filter(log => log.event_id === eventId);
};

/**
 * Get audit logs by action
 */
export const getAuditLogsByAction = (action: AuditAction): AuditLog[] => {
  return mockAuditLogs.filter(log => log.action === action);
};

/**
 * Get audit logs by user ID
 */
export const getAuditLogsByUserId = (userId: string): AuditLog[] => {
  return mockAuditLogs.filter(log => log.user_id === userId);
};

/**
 * Get audit logs for event by action type
 */
export const getAuditLogsByEventAndAction = (
  eventId: string,
  action: AuditAction
): AuditLog[] => {
  return mockAuditLogs.filter(
    log => log.event_id === eventId && log.action === action
  );
};

/**
 * Get single audit log by ID
 */
export const getAuditLogById = (id: string): AuditLog | undefined => {
  return mockAuditLogs.find(log => log.id === id);
};

/**
 * Reset mock data (for testing)
 */
export const resetMockAuditLogs = (): void => {
  mockAuditLogs.length = 0;
  mockAuditLogs.push(
    {
      id: 'audit_001',
      event_id: 'evt_001',
      action: AuditAction.CLARIFICATION_REQUESTED,
      user_id: 'coord_001',
      message: 'Could you please clarify the venue requirements?',
      created_at: new Date('2025-09-12T10:30:00Z')
    }
  );
};