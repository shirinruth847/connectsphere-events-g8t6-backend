/**
 * SUBTASK 1: ClarificationRequest Types
 * TypeScript interfaces and types for the ClarificationRequest feature
 */

/**
 * ClarificationRequestStatus enum
 * Represents the current status of a clarification request
 */
export enum ClarificationRequestStatus {
  PENDING = 'PENDING',           // Awaiting organiser response
  RESPONDED = 'RESPONDED',       // Organiser has resubmitted event
}

/**
 * ClarificationRequest interface
 * Represents a single clarification request in the database
 */
export interface ClarificationRequest {
  // Identifiers
  id: string;                          // UUID
  event_id: string;                    // Reference to event
  coordinator_id: string;              // Reference to coordinator who requested clarification

  // Content
  message: string;                     // Clarification message (10-500 chars)

  // Status
  status: ClarificationRequestStatus;

  // Timestamps
  created_at: Date;                    // When clarification was requested
  updated_at: Date;                    // Last updated
}

/**
 * CreateClarificationRequestInput
 * Input data for creating a new clarification request
 */
export interface CreateClarificationRequestInput {
  event_id: string;
  coordinator_id: string;
  message: string;
}

/**
 * ClarificationRequestResponse
 * Response object returned from API endpoints
 */
export interface ClarificationRequestResponse {
  id: string;
  event_id: string;
  coordinator_id: string;
  message: string;
  status: ClarificationRequestStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * ClarificationRequestWithCoordinatorDetails
 * Extended response that includes coordinator information
 * Used when displaying clarification to organisers
 */
export interface ClarificationRequestWithCoordinatorDetails extends ClarificationRequest {
  coordinator?: {
    id: string;
    name: string;
    email: string;
  };
}

/**
 * ClarificationRequestHistory
 * Timeline entry showing a clarification request and its response
 */
export interface ClarificationRequestHistoryEntry {
  request: ClarificationRequestWithCoordinatorDetails;
  status: 'PENDING' | 'RESPONDED';
  responded_at?: Date;
}

/**
 * ClarificationRequestError
 * Custom error type for clarification-related errors
 */
export interface ClarificationRequestError {
  code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'CONFLICT' | 'INTERNAL_ERROR';
  message: string;
  details?: Record<string, any>;
}

/**
 * Validation error codes
 */
export const ClarificationValidationErrors = {
  EMPTY_MESSAGE: 'Message cannot be empty',
  MESSAGE_TOO_SHORT: 'Message must be at least 10 characters',
  MESSAGE_TOO_LONG: 'Message cannot exceed 500 characters',
  INVALID_EVENT_ID: 'Invalid event ID',
  INVALID_COORDINATOR_ID: 'Invalid coordinator ID',
  EVENT_NOT_FOUND: 'Event not found',
  COORDINATOR_NOT_ASSIGNED: 'Coordinator is not assigned to this event',
  INVALID_EVENT_STATUS: 'Event must be in SUBMITTED status to request clarification',
} as const;