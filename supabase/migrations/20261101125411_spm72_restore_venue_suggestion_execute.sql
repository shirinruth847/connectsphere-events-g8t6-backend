-- Restore the backend execution grant from the original SPM-72 migration.
-- The deployed function body already matches the repository. Keep browser
-- roles denied and preserve the function, its ownership checks and all data.
GRANT EXECUTE ON FUNCTION public.suggest_event_venue(integer, integer, integer, integer, text, text)
  TO service_role;
