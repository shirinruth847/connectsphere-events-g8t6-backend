/**
 * SUBTASK 2: Event Types with Updated Status Enum
 * TypeScript interfaces and types for the Event feature
 * Updated to include RETURNED_FOR_CLARIFICATION status
 */

/**
 * EventStatus enum
 * Represents all possible statuses for an event throughout its lifecycle
 */
export enum EventStatus {
  DRAFT = 'DRAFT',                                        // Event not yet submitted
  SUBMITTED = 'SUBMITTED',                                // Event submitted, awaiting review
  UNDER_REVIEW = 'UNDER_REVIEW',                          // Coordinator actively reviewing
  RETURNED_FOR_CLARIFICATION = 'RETURNED_FOR_CLARIFICATION', // Coordinator requested clarification (NEW in Subtask 2)
  APPROVED = 'APPROVED',                                  // Coordinator approved, same as CONFIRMED
  PLANNING = 'PLANNING',                                  // Arranging venue and equipment
  CONFIRMED = 'CONFIRMED',                                // All arrangements confirmed
  COMPLETED = 'COMPLETED',                                // Event has finished
  REJECTED = 'REJECTED',                                  // Coordinator rejected the request
  CANCELLED = 'CANCELLED',                                // Organiser cancelled the event
}

/**
 * Event interface
 * Represents a single event in the database
 */
export interface Event {
  // Identifiers
  id: string;                                    // UUID
  organiser_id: string;                          // Reference to organiser (user)
  coordinator_id?: string;                       // Reference to assigned coordinator

  // Basic information
  name: string;                                  // Event name
  purpose: string;                               // Why event is happening
  description: string;                           // Detailed description

  // Event details
  expected_attendance: number;                   // How many people expected
  proposed_date: Date;                           // Suggested date/time
  proposed_time?: string;                        // Time in HH:MM format

  // Requirements
  venue_requirements?: string;                   // What organiser needs from venue
  accessibility_needs?: string[];                // Accessibility requirements
  equipment_requirements?: EquipmentRequirement[]; // Equipment needed
  registration_enabled?: boolean;                // Whether attendees need to register

  // Status (updated in Subtask 2)
  status: EventStatus;                           // Current status of event

  // Timestamps
  created_at: Date;                              // When event was created
  updated_at: Date;                              // Last modified
  submitted_at?: Date;                           // When submitted (if applicable)
}

/**
 * EquipmentRequirement interface
 * Details about specific equipment needed for an event
 */
export interface EquipmentRequirement {
  type: string;                                  // Type of equipment (e.g., "projector", "microphone")
  quantity: number;                              // How many units needed
  technical_requirements?: string;               // Special requirements
}

/**
 * CreateEventInput interface
 * Input data for creating a new event
 */
export interface CreateEventInput {
  organiser_id: string;
  name: string;
  purpose: string;
  description: string;
  expected_attendance: number;
  proposed_date: Date;
  proposed_time?: string;
  venue_requirements?: string;
  accessibility_needs?: string[];
  equipment_requirements?: EquipmentRequirement[];
  registration_enabled?: boolean;
}

/**
 * UpdateEventInput interface
 * Input data for updating an event
 */
export interface UpdateEventInput {
  name?: string;
  purpose?: string;
  description?: string;
  expected_attendance?: number;
  proposed_date?: Date;
  proposed_time?: string;
  venue_requirements?: string;
  accessibility_needs?: string[];
  equipment_requirements?: EquipmentRequirement[];
  registration_enabled?: boolean;
  status?: EventStatus;
}

/**
 * EventResponse interface
 * Response object returned from API endpoints
 */
export interface EventResponse {
  id: string;
  organiser_id: string;
  coordinator_id?: string;
  name: string;
  purpose: string;
  description: string;
  expected_attendance: number;
  proposed_date: Date;
  status: EventStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * EventStatusTransition interface
 * Represents valid status transitions for audit logging
 */
export interface EventStatusTransition {
  from: EventStatus;
  to: EventStatus;
  triggered_by: 'SYSTEM' | 'ORGANISER' | 'COORDINATOR';
  reason?: string;
  timestamp: Date;
}

/**
 * Valid status transitions mapping
 * Defines which statuses can transition to which
 */
export const ValidEventStatusTransitions: Record<EventStatus, EventStatus[]> = {
  [EventStatus.DRAFT]: [EventStatus.SUBMITTED, EventStatus.CANCELLED],
  [EventStatus.SUBMITTED]: [EventStatus.UNDER_REVIEW, EventStatus.RETURNED_FOR_CLARIFICATION, EventStatus.REJECTED],
  [EventStatus.UNDER_REVIEW]: [EventStatus.RETURNED_FOR_CLARIFICATION, EventStatus.APPROVED, EventStatus.REJECTED],
  [EventStatus.RETURNED_FOR_CLARIFICATION]: [EventStatus.SUBMITTED, EventStatus.CANCELLED], // NEW in Subtask 2
  [EventStatus.APPROVED]: [EventStatus.PLANNING, EventStatus.REJECTED, EventStatus.CANCELLED],
  [EventStatus.PLANNING]: [EventStatus.CONFIRMED, EventStatus.CANCELLED],
  [EventStatus.CONFIRMED]: [EventStatus.COMPLETED, EventStatus.CANCELLED],
  [EventStatus.COMPLETED]: [EventStatus.CANCELLED],
  [EventStatus.REJECTED]: [],  // Terminal state
  [EventStatus.CANCELLED]: [], // Terminal state
};

/**
 * Check if a status transition is valid
 */
export const isValidStatusTransition = (from: EventStatus, to: EventStatus): boolean => {
  return ValidEventStatusTransitions[from]?.includes(to) ?? false;
};

/**
 * Get human-readable status label
 */
export const getStatusLabel = (status: EventStatus): string => {
  const labels: Record<EventStatus, string> = {
    [EventStatus.DRAFT]: 'Draft',
    [EventStatus.SUBMITTED]: 'Submitted',
    [EventStatus.UNDER_REVIEW]: 'Under Review',
    [EventStatus.RETURNED_FOR_CLARIFICATION]: 'Returned for Clarification',
    [EventStatus.APPROVED]: 'Approved',
    [EventStatus.PLANNING]: 'Planning',
    [EventStatus.CONFIRMED]: 'Confirmed',
    [EventStatus.COMPLETED]: 'Completed',
    [EventStatus.REJECTED]: 'Rejected',
    [EventStatus.CANCELLED]: 'Cancelled',
  };
  return labels[status] || status;
};