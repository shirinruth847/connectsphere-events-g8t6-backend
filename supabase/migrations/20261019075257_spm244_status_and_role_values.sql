-- SPM-244 (subtask of SPM-243), needed by SPM-173: the Master v1.1 lifecycle
-- states and the Safety Officer role (Master sections 3.1 and 5.2).
--
-- The live enums predate Master 1.0: event_status has no SAFETY_REVIEW or
-- PREPARATION, and user_role has no SAFETY_OFFICER. The values are added in
-- lifecycle order. The unused APPROVED value stays, because Postgres cannot drop
-- an enum value in place and no row uses it; nothing transitions into it.
--
-- Kept in its own migration: a new enum value cannot be used in the
-- transaction that adds it, and later migrations reference these values.

ALTER TYPE public.event_status ADD VALUE IF NOT EXISTS 'SAFETY_REVIEW' BEFORE 'CONFIRMED';
ALTER TYPE public.event_status ADD VALUE IF NOT EXISTS 'PREPARATION' AFTER 'CONFIRMED';

ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'SAFETY_OFFICER';
