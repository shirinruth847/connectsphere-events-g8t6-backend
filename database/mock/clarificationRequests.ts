/**
 * SUBTASK 1: Mock Clarification Requests Data
 * This file provides dummy data for local development without Supabase
 */

import { ClarificationRequest, ClarificationRequestStatus } from '../types/clarificationRequest';

/**
 * Mock clarification requests
 * These are used for development and testing before Supabase is set up
 */
export const mockClarificationRequests: ClarificationRequest[] = [
  {
    id: 'clr_001',
    event_id: 'evt_001',
    coordinator_id: 'coord_001',
    message: 'Could you please clarify the venue requirements? We need to know the exact seating layout you prefer (classroom, theater, or banquet style).',
    status: ClarificationRequestStatus.PENDING,
    created_at: new Date('2025-09-12T10:30:00Z'),
    updated_at: new Date('2025-09-12T10:30:00Z'),
  },
  {
    id: 'clr_002',
    event_id: 'evt_002',
    coordinator_id: 'coord_001',
    message: 'The expected attendance of 200 people may exceed some venue capacities. Can you confirm this number is accurate?',
    status: ClarificationRequestStatus.RESPONDED,
    created_at: new Date('2025-09-11T14:15:00Z'),
    updated_at: new Date('2025-09-12T09:00:00Z'),
  },
  {
    id: 'clr_003',
    event_id: 'evt_003',
    coordinator_id: 'coord_002',
    message: 'Please provide more details about the equipment needed. Currently listed as "audio system" but we need to know: speaker count, microphone types, and any special requirements.',
    status: ClarificationRequestStatus.PENDING,
    created_at: new Date('2025-09-12T11:45:00Z'),
    updated_at: new Date('2025-09-12T11:45:00Z'),
  },
  {
    id: 'clr_004',
    event_id: 'evt_004',
    coordinator_id: 'coord_002',
    message: 'You mentioned accessibility requirements but did not specify if wheelchair access is needed. Can you clarify?',
    status: ClarificationRequestStatus.RESPONDED,
    created_at: new Date('2025-09-10T16:20:00Z'),
    updated_at: new Date('2025-09-11T13:00:00Z'),
  },
  {
    id: 'clr_005',
    event_id: 'evt_005',
    coordinator_id: 'coord_001',
    message: 'The proposed date (Sept 25) conflicts with another event. Can you provide alternative dates?',
    status: ClarificationRequestStatus.PENDING,
    created_at: new Date('2025-09-12T13:30:00Z'),
    updated_at: new Date('2025-09-12T13:30:00Z'),
  },
];

/**
 * Get all clarification requests (development only)
 */
export const getAllClarificationRequests = (): ClarificationRequest[] => {
  return mockClarificationRequests;
};

/**
 * Get clarification requests for a specific event
 */
export const getClarificationRequestsByEventId = (eventId: string): ClarificationRequest[] => {
  return mockClarificationRequests.filter(req => req.event_id === eventId);
};

/**
 * Get clarification requests by status
 */
export const getClarificationRequestsByStatus = (
  status: ClarificationRequestStatus
): ClarificationRequest[] => {
  return mockClarificationRequests.filter(req => req.status === status);
};

/**
 * Get single clarification request by ID
 */
export const getClarificationRequestById = (id: string): ClarificationRequest | undefined => {
  return mockClarificationRequests.find(req => req.id === id);
};

/**
 * Create a new mock clarification request
 * (In real implementation, this would save to database)
 */
export const createMockClarificationRequest = (
  eventId: string,
  coordinatorId: string,
  message: string
): ClarificationRequest => {
  const newRequest: ClarificationRequest = {
    id: `clr_${Date.now()}`,
    event_id: eventId,
    coordinator_id: coordinatorId,
    message,
    status: ClarificationRequestStatus.PENDING,
    created_at: new Date(),
    updated_at: new Date(),
  };

  mockClarificationRequests.push(newRequest);
  return newRequest;
};

/**
 * Update clarification request status
 * (In real implementation, this would update database)
 */
export const updateMockClarificationRequestStatus = (
  id: string,
  status: ClarificationRequestStatus
): ClarificationRequest | undefined => {
  const index = mockClarificationRequests.findIndex(req => req.id === id);
  if (index > -1) {
    mockClarificationRequests[index].status = status;
    mockClarificationRequests[index].updated_at = new Date();
    return mockClarificationRequests[index];
  }
  return undefined;
};

/**
 * Delete a clarification request
 * (In real implementation, this would delete from database)
 */
export const deleteMockClarificationRequest = (id: string): boolean => {
  const index = mockClarificationRequests.findIndex(req => req.id === id);
  if (index > -1) {
    mockClarificationRequests.splice(index, 1);
    return true;
  }
  return false;
};

/**
 * Reset mock data to initial state
 * Useful for testing
 */
export const resetMockClarificationRequests = (): void => {
  mockClarificationRequests.length = 0;
  mockClarificationRequests.push(
    {
      id: 'clr_001',
      event_id: 'evt_001',
      coordinator_id: 'coord_001',
      message: 'Could you please clarify the venue requirements? We need to know the exact seating layout you prefer (classroom, theater, or banquet style).',
      status: ClarificationRequestStatus.PENDING,
      created_at: new Date('2025-09-12T10:30:00Z'),
      updated_at: new Date('2025-09-12T10:30:00Z'),
    },
    {
      id: 'clr_002',
      event_id: 'evt_002',
      coordinator_id: 'coord_001',
      message: 'The expected attendance of 200 people may exceed some venue capacities. Can you confirm this number is accurate?',
      status: ClarificationRequestStatus.RESPONDED,
      created_at: new Date('2025-09-11T14:15:00Z'),
      updated_at: new Date('2025-09-12T09:00:00Z'),
    }
  );
};