-- Some development databases already received this value with SPM-244.
-- Keep fresh environments compatible without rewriting applied migrations.
ALTER TYPE public.event_status ADD VALUE IF NOT EXISTS 'PREPARATION';
