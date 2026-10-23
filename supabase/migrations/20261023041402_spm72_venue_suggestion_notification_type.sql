-- SPM-72/SPM-74: notification type for a coordinator's venue suggestion to the
-- organiser. Its own migration because a new enum value must be committed
-- before the event_venue_suggestion migration can use it.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'VENUE_SUGGESTION';
