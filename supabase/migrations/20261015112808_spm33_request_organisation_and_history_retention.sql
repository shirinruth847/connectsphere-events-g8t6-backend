-- SPM-33 review fixes (2026-10-15):
--   1. A request belongs to its organiser's organisation, so same-organisation
--      organisers can see it once it is submitted (AC1, TC-03). Until now nothing
--      set event.organisation_id, so that view never applied to real requests.
--   2. Change history outlives the people who made the changes. Deleting a user
--      profile used to cascade into activity_log; it is now refused (Master
--      section 6.1: do not cascade an account deletion into audit history).

-- ---------- 1. Organisation of a request ----------

-- The organiser's organisation when they belong to exactly one, otherwise null:
-- with no membership (or, later, several and no recorded choice) the request
-- stays visible to its owner only.
CREATE FUNCTION public._organiser_sole_organisation(p_user_id integer)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(organisation_id) END
    FROM public.organisation_membership
   WHERE user_id = p_user_id;
$$;

-- A trigger, like event_bump_version, so every writer is covered: drafts, direct
-- submissions and anything another ticket inserts. A writer that names an
-- organisation keeps it. An existing request is only filled in when it leaves
-- DRAFT, so joining an organisation later never exposes older requests.
CREATE FUNCTION public._event_default_organisation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.organisation_id IS NULL
     AND (TG_OP = 'INSERT' OR (OLD.status = 'DRAFT' AND NEW.status <> 'DRAFT')) THEN
    NEW.organisation_id := public._organiser_sole_organisation(NEW.organiser_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER event_default_organisation
  BEFORE INSERT OR UPDATE OF status ON public.event
  FOR EACH ROW EXECUTE FUNCTION public._event_default_organisation();

-- Existing requests whose organiser has exactly one organisation. Each updated
-- row also gets a new version (event_bump_version).
UPDATE public.event AS e
   SET organisation_id = public._organiser_sole_organisation(e.organiser_id)
 WHERE e.organisation_id IS NULL
   AND public._organiser_sole_organisation(e.organiser_id) IS NOT NULL;

-- ---------- 2. History is kept when a profile is deleted ----------

ALTER TABLE public.activity_log
  DROP CONSTRAINT activity_log_user_id_fkey,
  ADD CONSTRAINT activity_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public."user"(user_id) ON DELETE RESTRICT;

-- ---------- 3. Privileges ----------

REVOKE ALL ON FUNCTION public._organiser_sole_organisation(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._event_default_organisation() FROM PUBLIC, anon, authenticated, service_role;
