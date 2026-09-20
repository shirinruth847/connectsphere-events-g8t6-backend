-- SUBTASK 1: Create ClarificationRequest Table
-- This table stores all clarification requests made by Event Coordinators
-- to Event Organisers for submitted event requests

CREATE TABLE clarification_requests (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Foreign keys
  event_id UUID NOT NULL,
  coordinator_id UUID NOT NULL,
  
  -- Message content
  message VARCHAR(500) NOT NULL,
  
  -- Status tracking
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
  CONSTRAINT valid_status CHECK (status IN ('PENDING', 'RESPONDED')),
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Indexes for common queries
  -- Query by event_id (for organisers viewing clarifications for their event)
  CONSTRAINT fk_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_coordinator FOREIGN KEY (coordinator_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX idx_clarification_event_id ON clarification_requests(event_id);
CREATE INDEX idx_clarification_created_at ON clarification_requests(created_at DESC);
CREATE INDEX idx_clarification_event_created ON clarification_requests(event_id, created_at DESC);
CREATE INDEX idx_clarification_status ON clarification_requests(status);

-- Add comment for documentation
COMMENT ON TABLE clarification_requests IS 'Stores clarification requests from coordinators to organisers for submitted event requests';
COMMENT ON COLUMN clarification_requests.id IS 'Unique identifier for the clarification request';
COMMENT ON COLUMN clarification_requests.event_id IS 'Reference to the event being clarified';
COMMENT ON COLUMN clarification_requests.coordinator_id IS 'Reference to the coordinator who requested clarification';
COMMENT ON COLUMN clarification_requests.message IS 'The clarification message (10-500 characters)';
COMMENT ON COLUMN clarification_requests.status IS 'PENDING = awaiting organiser response, RESPONDED = organiser has resubmitted event';