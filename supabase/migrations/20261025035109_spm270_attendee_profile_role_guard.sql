-- SPM-270 follow-up: only ATTENDEE users may hold an attendee_profile (Master
-- 6.3). Migration 20261024095646 added a trigger for new writes, but it does
-- not check rows that were already in the table before it ran. This migration
-- checks them and refuses to complete while any profile belongs to a user whose
-- role is not ATTENDEE. It never deletes, rewrites or reassigns a profile:
-- resolve each listed row deliberately, then run the migration again. When it
-- refuses, the transaction rolls back and nothing changes. It changes no
-- constraint, trigger, function or grant.

BEGIN;

-- Holds off new profile writes while the existing rows are checked.
LOCK TABLE public.attendee_profile IN SHARE MODE;

DO $$
DECLARE
  v_count integer;
  v_rows text;
BEGIN
  SELECT count(*),
         string_agg(format('attendee_id %s (user_id %s, role %s)', p.attendee_id, p.user_id, u.role), '; ' ORDER BY p.attendee_id)
    INTO v_count, v_rows
    FROM public.attendee_profile AS p
    JOIN public."user" AS u ON u.user_id = p.user_id
   WHERE u.role <> 'ATTENDEE';

  IF v_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = format('SPM-270 migration refused: %s attendee_profile row(s) belong to non-ATTENDEE users: %s', v_count, v_rows),
      HINT = 'Only ATTENDEE users may hold an attendee profile. Resolve these rows, then rerun this migration. Nothing was changed.';
  END IF;
END;
$$;

COMMIT;
