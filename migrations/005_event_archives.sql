-- Preserve completed events as immutable archives while keeping share controls usable.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Events marked complete before this migration become archived from their last update time.
UPDATE public.events
SET completed_at = COALESCE(updated_at, created_at, now())
WHERE status = 'completed' AND completed_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_completion_timestamp_check'
      AND conrelid = 'public.events'::regclass
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_completion_timestamp_check
      CHECK ((status = 'completed') = (completed_at IS NOT NULL));
  END IF;
END;
$$;

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
    -- Permit parent-account cleanup cascades; direct event deletion remains blocked.
    IF OLD.status = 'completed' AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'Completed events are archived and cannot be deleted.'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'completed' THEN
    -- The owner may still rotate/revoke a public link; archived event data stays frozen.
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

DROP TRIGGER IF EXISTS events_completed_archive_guard ON public.events;
CREATE TRIGGER events_completed_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.events
FOR EACH ROW EXECUTE FUNCTION public.enforce_completed_event_archive();

CREATE OR REPLACE FUNCTION public.prevent_completed_event_child_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_event_id uuid;
  target_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    RAISE EXCEPTION 'A record cannot be moved between events.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_event_id := OLD.event_id;
  ELSE
    target_event_id := NEW.event_id;
  END IF;

  -- Serialize each child write with the event status transition.
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

DROP TRIGGER IF EXISTS transactions_completed_archive_guard ON public.transactions;
CREATE TRIGGER transactions_completed_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_completed_event_child_mutation();

DROP TRIGGER IF EXISTS participants_completed_archive_guard ON public.participants;
CREATE TRIGGER participants_completed_archive_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.participants
FOR EACH ROW EXECUTE FUNCTION public.prevent_completed_event_child_mutation();
