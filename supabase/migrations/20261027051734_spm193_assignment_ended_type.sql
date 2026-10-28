-- SPM-193: the notice a coordinator receives when an event is reassigned away
-- from them (AC2) gets its own type, so their inbox can keep showing it after
-- every other notice about that event is hidden (AC10).
--
-- Added on its own because a new enum value cannot be used in the transaction
-- that adds it; the functions that use it follow in later migrations. Existing
-- values and rows are unchanged.
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'ASSIGNMENT_ENDED';
