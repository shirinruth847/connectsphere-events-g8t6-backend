/**
 * SUBTASK 2: Mock Events Data
 * This file provides dummy data for local development without Supabase
 * Updated to include RETURNED_FOR_CLARIFICATION status
 */

import { Event, EventStatus, EquipmentRequirement } from '../types/';

/**
 * Mock events
 * These are used for development and testing before Supabase is set up
 * Events are in various states including the new RETURNED_FOR_CLARIFICATION status
 */
export const mockEvents: Event[] = [
  {
    id: 'evt_001',
    organiser_id: 'org_001',
    coordinator_id: 'coord_001',
    name: 'Annual Company Conference 2025',
    purpose: 'Team alignment and strategy presentation',
    description: 'Annual conference bringing together all employees to discuss company direction and goals for 2025.',
    expected_attendance: 150,
    proposed_date: new Date('2025-10-15'),
    proposed_time: '09:00',
    venue_requirements: 'Large auditorium with presentation equipment',
    accessibility_needs: ['wheelchair_access', 'hearing_loop'],
    equipment_requirements: [
      { type: 'projector', quantity: 1 },
      { type: 'microphone', quantity: 3 },
      { type: 'sound_system', quantity: 1 },
    ],
    registration_enabled: true,
    status: EventStatus.RETURNED_FOR_CLARIFICATION, // NEW: This event is waiting for organiser's clarification
    created_at: new Date('2025-09-10'),
    updated_at: new Date('2025-09-12'),
    submitted_at: new Date('2025-09-11'),
  },
  {
    id: 'evt_002',
    organiser_id: 'org_002',
    coordinator_id: 'coord_001',
    name: 'Product Launch Event',
    purpose: 'Launch new product to market and media',
    description: 'Product launch featuring live demo and Q&A with leadership.',
    expected_attendance: 200,
    proposed_date: new Date('2025-10-22'),
    proposed_time: '14:00',
    venue_requirements: 'Modern venue with demo area and media setup',
    accessibility_needs: ['wheelchair_access', 'accessible_parking'],
    equipment_requirements: [
      { type: 'projector', quantity: 2 },
      { type: 'video_conferencing_kit', quantity: 1 },
    ],
    registration_enabled: true,
    status: EventStatus.SUBMITTED,
    created_at: new Date('2025-09-08'),
    updated_at: new Date('2025-09-12'),
    submitted_at: new Date('2025-09-12'),
  },
  {
    id: 'evt_003',
    organiser_id: 'org_001',
    coordinator_id: 'coord_002',
    name: 'Team Building Workshop',
    purpose: 'Build team cohesion and communication',
    description: 'Half-day team building activities and workshops for the engineering team.',
    expected_attendance: 50,
    proposed_date: new Date('2025-09-28'),
    proposed_time: '10:00',
    venue_requirements: 'Breakout rooms for group activities',
    accessibility_needs: ['wheelchair_access'],
    equipment_requirements: [
      { type: 'projector', quantity: 1 },
      { type: 'microphone', quantity: 2 },
    ],
    registration_enabled: false,
    status: EventStatus.UNDER_REVIEW,
    created_at: new Date('2025-09-11'),
    updated_at: new Date('2025-09-12'),
    submitted_at: new Date('2025-09-11'),
  },
  {
    id: 'evt_004',
    organiser_id: 'org_003',
    coordinator_id: 'coord_002',
    name: 'Budget Planning Meeting',
    purpose: 'Quarterly budget review',
    description: 'Finance team quarterly budget review meeting.',
    expected_attendance: 20,
    proposed_date: new Date('2025-09-25'),
    proposed_time: '11:00',
    venue_requirements: 'Meeting room with video conferencing',
    accessibility_needs: [],
    equipment_requirements: [
      { type: 'video_conferencing_kit', quantity: 1 },
    ],
    registration_enabled: false,
    status: EventStatus.RETURNED_FOR_CLARIFICATION, // NEW: Another event in clarification status
    created_at: new Date('2025-09-09'),
    updated_at: new Date('2025-09-12'),
    submitted_at: new Date('2025-09-10'),
  },
  {
    id: 'evt_005',
    organiser_id: 'org_002',
    coordinator_id: 'coord_001',
    name: 'Client Summit 2025',
    purpose: 'Annual client appreciation and roadmap review',
    description: 'Annual event for key clients to review product roadmap and build relationships.',
    expected_attendance: 100,
    proposed_date: new Date('2025-11-05'),
    proposed_time: '13:00',
    venue_requirements: 'Premium venue with catering',
    accessibility_needs: ['wheelchair_access', 'accessible_parking', 'hearing_loop'],
    equipment_requirements: [
      { type: 'projector', quantity: 2 },
      { type: 'microphone', quantity: 4 },
      { type: 'sound_system', quantity: 1 },
    ],
    registration_enabled: true,
    status: EventStatus.DRAFT,
    created_at: new Date('2025-09-12'),
    updated_at: new Date('2025-09-12'),
  },
  {
    id: 'evt_006',
    organiser_id: 'org_001',
    coordinator_id: 'coord_002',
    name: 'Training Workshop',
    purpose: 'New employee onboarding training',
    description: 'Comprehensive onboarding and training program for new hires.',
    expected_attendance: 30,
    proposed_date: new Date('2025-10-01'),
    proposed_time: '09:00',
    venue_requirements: 'Training room with breakout areas',
    accessibility_needs: ['wheelchair_access'],
    equipment_requirements: [
      { type: 'projector', quantity: 1 },
      { type: 'microphone', quantity: 2 },
    ],
    registration_enabled: false,
    status: EventStatus.CONFIRMED,
    created_at: new Date('2025-09-05'),
    updated_at: new Date('2025-09-11'),
    submitted_at: new Date('2025-09-06'),
  },
];

/**
 * Get all events (development only)
 */
export const getAllEvents = (): Event[] => {
  return mockEvents;
};

/**
 * Get event by ID
 */
export const getEventById = (id: string): Event | undefined => {
  return mockEvents.find(event => event.id === id);
};

/**
 * Get events by organiser ID
 */
export const getEventsByOrganiserId = (organiserId: string): Event[] => {
  return mockEvents.filter(event => event.organiser_id === organiserId);
};

/**
 * Get events by coordinator ID
 */
export const getEventsByCoordinatorId = (coordinatorId: string): Event[] => {
  return mockEvents.filter(event => event.coordinator_id === coordinatorId);
};

/**
 * Get events by status
 */
export const getEventsByStatus = (status: EventStatus): Event[] => {
  return mockEvents.filter(event => event.status === status);
};

/**
 * Get events in RETURNED_FOR_CLARIFICATION status (for testing Subtask 1 & 2)
 */
export const getEventsPendingClarification = (): Event[] => {
  return mockEvents.filter(event => event.status === EventStatus.RETURNED_FOR_CLARIFICATION);
};

/**
 * Create a new mock event
 * (In real implementation, this would save to database)
 */
export const createMockEvent = (input: Omit<Event, 'id' | 'created_at' | 'updated_at'>): Event => {
  const newEvent: Event = {
    ...input,
    id: `evt_${Date.now()}`,
    created_at: new Date(),
    updated_at: new Date(),
  };

  mockEvents.push(newEvent);
  return newEvent;
};

/**
 * Update event status
 * (In real implementation, this would update database)
 */
export const updateMockEventStatus = (eventId: string, newStatus: EventStatus): Event | undefined => {
  const event = mockEvents.find(e => e.id === eventId);
  if (event) {
    event.status = newStatus;
    event.updated_at = new Date();
    return event;
  }
  return undefined;
};

/**
 * Update event
 * (In real implementation, this would update database)
 */
export const updateMockEvent = (eventId: string, updates: Partial<Event>): Event | undefined => {
  const event = mockEvents.find(e => e.id === eventId);
  if (event) {
    Object.assign(event, updates);
    event.updated_at = new Date();
    return event;
  }
  return undefined;
};

/**
 * Delete an event
 * (In real implementation, this would delete from database)
 */
export const deleteMockEvent = (id: string): boolean => {
  const index = mockEvents.findIndex(event => event.id === id);
  if (index > -1) {
    mockEvents.splice(index, 1);
    return true;
  }
  return false;
};

/**
 * Reset mock data to initial state
 * Useful for testing
 */
export const resetMockEvents = (): void => {
  mockEvents.length = 0;
  mockEvents.push(
    {
      id: 'evt_001',
      organiser_id: 'org_001',
      coordinator_id: 'coord_001',
      name: 'Annual Company Conference 2025',
      purpose: 'Team alignment and strategy presentation',
      description: 'Annual conference bringing together all employees to discuss company direction and goals for 2025.',
      expected_attendance: 150,
      proposed_date: new Date('2025-10-15'),
      proposed_time: '09:00',
      venue_requirements: 'Large auditorium with presentation equipment',
      accessibility_needs: ['wheelchair_access', 'hearing_loop'],
      equipment_requirements: [
        { type: 'projector', quantity: 1 },
        { type: 'microphone', quantity: 3 },
      ],
      registration_enabled: true,
      status: EventStatus.RETURNED_FOR_CLARIFICATION,
      created_at: new Date('2025-09-10'),
      updated_at: new Date('2025-09-12'),
      submitted_at: new Date('2025-09-11'),
    }
  );
};