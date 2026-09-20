-- SUBTASK 2: Update Event Status Enum
-- This migration adds "RETURNED_FOR_CLARIFICATION" status to the Event table
-- This status is used when a coordinator requests clarification on a submitted event

-- First, backup the current status constraint (if needed for rollback)
-- In PostgreSQL, we need to handle the enum type updates carefully

-- Option 1: If using ENUM type (recommended approach)
-- Extend the existing enum
ALTER TYPE event_status ADD VALUE 'RETURNED_FOR_CLARIFICATION' AFTER 'SUBMITTED';

-- Option 2: If status is just VARCHAR with CHECK constraint
-- You would need to update the CHECK constraint instead:
-- Uncomment the lines below if NOT using ENUM type

/*
-- Remove the existing CHECK constraint
ALTER TABLE events DROP CONSTRAINT valid_event_status;

-- Add new CHECK constraint with updated statuses
ALTER TABLE events
ADD CONSTRAINT valid_event_status CHECK (
  status IN (
    'DRAFT',
    'SUBMITTED',
    'UNDER_REVIEW',
    'RETURNED_FOR_CLARIFICATION',
    'APPROVED',
    'PLANNING',
    'CONFIRMED',
    'COMPLETED',
    'REJECTED',
    'CANCELLED'
  )
);
*/

-- Add comment documenting the new status
COMMENT ON COLUMN events.status IS 'Event status: DRAFT=unsaved, SUBMITTED=awaiting review, UNDER_REVIEW=coordinator reviewing, RETURNED_FOR_CLARIFICATION=coordinator requested clarification, APPROVED=approved to proceed, PLANNING=arranging venue/equipment, CONFIRMED=all arrangements confirmed, COMPLETED=event finished, REJECTED=coordinator rejected, CANCELLED=organiser cancelled';

-- Verify the migration worked (run after migration to confirm)
-- SELECT DISTINCT status FROM events;