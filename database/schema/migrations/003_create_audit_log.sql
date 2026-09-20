-- SUBTASK 4: Create AuditLog Table
-- Immutable audit trail for tracking all clarification-related events
-- This table enforces immutability by disabling UPDATE and DELETE operations

CREATE TABLE audit_logs (
  -- Primary key
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Foreign keys
  event_id UUID NOT NULL,
  user_id UUID NOT NULL,
  
  -- Action tracking
  action VARCHAR(50) NOT NULL,
  
  -- Content
  message TEXT NOT NULL,
  metadata JSONB,
  
  -- Immutability enforcement - timestamp only
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  -- Constraints
  CONSTRAINT fk_audit_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT valid_audit_action CHECK (action IN ('CLARIFICATION_REQUESTED', 'EVENT_RESUBMITTED'))
);

-- Create indexes for common queries
CREATE INDEX idx_audit_logs_event_id ON audit_logs(event_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_event_action ON audit_logs(event_id, action);
CREATE INDEX idx_audit_logs_event_created ON audit_logs(event_id, created_at DESC);

-- Enforce immutability: prevent updates to audit logs
CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;

-- Enforce immutability: prevent deletes from audit logs
CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;

-- Add comments for documentation
COMMENT ON TABLE audit_logs IS 'Immutable audit trail for event lifecycle tracking. Tracks all clarification requests and event resubmissions.';
COMMENT ON COLUMN audit_logs.id IS 'Unique identifier for the audit log entry';
COMMENT ON COLUMN audit_logs.event_id IS 'Reference to the event being logged';
COMMENT ON COLUMN audit_logs.user_id IS 'Reference to the user who performed the action (coordinator or organiser)';
COMMENT ON COLUMN audit_logs.action IS 'Type of action: CLARIFICATION_REQUESTED or EVENT_RESUBMITTED';
COMMENT ON COLUMN audit_logs.message IS 'Description of the action taken';
COMMENT ON COLUMN audit_logs.metadata IS 'Additional context data stored as JSON (optional)';
COMMENT ON COLUMN audit_logs.created_at IS 'Timestamp when the action occurred - immutable';