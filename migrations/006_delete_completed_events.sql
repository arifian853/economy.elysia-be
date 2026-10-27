-- Allow owners to delete a completed archive without allowing edits.
-- Child rows are removable only as part of a parent cascade; direct ledger edits/deletes remain blocked.

CREATE OR REPLACE FUNCTION public.enforce_completed_event_archive()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'completed' THEN
      RAISE EXCEPTION 'Create the event first, then complete it to archive it.'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF OLD.status = 'completed' THEN
    -- Public-link revocation remains allowed; all archived event data stays frozen.
    old_data := to_jsonb(OLD) - ARRAY['public_share_token', 'updated_at']::text[];
    new_data := to_jsonb(NEW) - ARRAY['public_share_token', 'updated_at']::text[];
    IF new_data IS DISTINCT FROM old_data THEN
      RAISE EXCEPTION 'Completed events are archived and cannot be changed.'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_completed_event_child_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_event_id uuid;
  target_status text;
BEGIN
  -- Parent event deletion cascades through these child triggers at depth > 1.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    RAISE EXCEPTION 'A record cannot be moved between events.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_event_id := OLD.event_id;
  ELSE
    target_event_id := NEW.event_id;
  END IF;

  SELECT status INTO target_status
  FROM public.events
  WHERE id = target_event_id
  FOR UPDATE;

  IF target_status = 'completed' THEN
    RAISE EXCEPTION 'Completed events are archived and cannot be changed.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_completed_archive_guard ON public.events;
CREATE TRIGGER events_completed_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.events
FOR EACH ROW EXECUTE FUNCTION public.enforce_completed_event_archive();

DROP TRIGGER IF EXISTS transactions_completed_archive_guard ON public.transactions;
CREATE TRIGGER transactions_completed_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_completed_event_child_mutation();

DROP TRIGGER IF EXISTS participants_completed_archive_guard ON public.participants;
CREATE TRIGGER participants_completed_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.participants
FOR EACH ROW EXECUTE FUNCTION public.prevent_completed_event_child_mutation();
