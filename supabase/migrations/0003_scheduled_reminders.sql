-- ============================================================
-- Migration: 0003_scheduled_reminders.sql
-- Description: Scheduled reminders (Milestone 2).
--
--   ADDITIVE migration. Creates:
--     1. `reminder_status` ENUM (pending/claimed/sent/failed/cancelled)
--     2. `public.reminders` table — reminder timestamps are stored
--        SEPARATELY from task due dates (tasks.due_date is untouched;
--        a task can exist with no reminder and vice versa).
--     3. Indexes for the scheduler's due-claim scan, per-user listing,
--        task lookup, and idempotent creation.
--     4. RLS policies: only the owner can read/insert/update/delete.
--     5. `claim_due_reminders()`  — atomic claim via
--        SELECT ... FOR UPDATE SKIP LOCKED (safe for multiple workers).
--     6. `recover_stale_reminders()` — crash recovery: claims stuck
--        longer than a threshold return to `pending` (or become
--        `failed` when no attempts remain).
--
--   Privileges: the two worker functions are executable ONLY by the
--   `service_role` (the background worker). Authenticated API traffic
--   never calls them — user-facing operations go through PostgREST
--   table access under RLS with the user's JWT.
--
--   Apply with:  supabase db push   (or paste into the SQL editor)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Delivery lifecycle for a reminder.
--    pending   -> due, waiting to be claimed by a worker
--    claimed   -> picked up by exactly one worker (in-flight)
--    sent      -> provider confirmed delivery
--    failed    -> attempts exhausted or permanent provider error
--    cancelled -> user cancelled before delivery
-- ------------------------------------------------------------

CREATE TYPE reminder_status AS ENUM ('pending', 'claimed', 'sent', 'failed', 'cancelled');

-- ------------------------------------------------------------
-- 2. reminders table
-- ------------------------------------------------------------

CREATE TABLE public.reminders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Optional link: reminders can exist without a task; deleting the
  -- task keeps the reminder (task_id -> NULL) rather than cascading.
  task_id          uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  -- Snapshot of what to remind about (task title or free text), so the
  -- email content survives task edits/deletion.
  title            text NOT NULL CHECK (length(btrim(title)) > 0),
  -- When to deliver. SEPARATE from tasks.due_date by design.
  reminder_at      timestamptz NOT NULL,
  status           reminder_status NOT NULL DEFAULT 'pending',
  -- Attempt accounting: attempts increments when a worker CLAIMS the
  -- row, so a crash mid-send still consumes an attempt (bounded retries).
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     integer NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  -- Retry scheduling: when the next claim is allowed to pick this up.
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_attempt_at  timestamptz,
  sent_at          timestamptz,
  failed_at        timestamptz,
  failure_reason   text,
  -- Claim bookkeeping for crash recovery (stale-claim detection).
  claimed_at       timestamptz,
  -- Optional client-supplied key making creation idempotent
  -- (unique per user when present).
  idempotency_key  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.reminders IS
  'Scheduled email reminders. reminder_at is independent of tasks.due_date: a task may have zero or many reminders, and a reminder may reference no task.';
COMMENT ON COLUMN public.reminders.reminder_at IS
  'When the reminder should be delivered (timestamptz, Asia/Kolkata for user-facing display).';
COMMENT ON COLUMN public.reminders.status IS
  'pending -> claimed (single worker) -> sent | failed; cancelled only from pending, set by the owner.';
COMMENT ON COLUMN public.reminders.next_attempt_at IS
  'Earliest time a worker may (re)claim this reminder; drives bounded exponential backoff for retries.';

-- ------------------------------------------------------------
-- 3. Indexes
-- ------------------------------------------------------------

-- Scheduler scan: due pending reminders ordered by next attempt.
CREATE INDEX reminders_due_claim_idx
  ON public.reminders (next_attempt_at)
  WHERE status = 'pending';

-- Stale-claim recovery scan.
CREATE INDEX reminders_stale_claim_idx
  ON public.reminders (claimed_at)
  WHERE status = 'claimed';

-- Per-user listing (upcoming first).
CREATE INDEX reminders_user_idx ON public.reminders (user_id, reminder_at DESC);

-- Task lookup (task_id IS NOT NULL only).
CREATE INDEX reminders_task_idx ON public.reminders (task_id)
  WHERE task_id IS NOT NULL;

-- Idempotent creation: one open reminder per (user, key).
CREATE UNIQUE INDEX reminders_idempotency_uidx
  ON public.reminders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ------------------------------------------------------------
-- 4. updated_at maintenance
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER reminders_set_updated_at
  BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 5. Row Level Security (owner-only, mirrors tasks/messages)
--    NOTE: the background worker uses the service_role key, which
--    bypasses RLS; all user-facing access goes through the user's
--    JWT so these policies apply on every statement.
-- ------------------------------------------------------------

ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY reminders_select_own ON public.reminders
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY reminders_insert_own ON public.reminders
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY reminders_update_own ON public.reminders
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY reminders_delete_own ON public.reminders
  FOR DELETE USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 6. Atomic claim for the background worker.
--
--    The whole claim (select due rows + flip them to `claimed`) is ONE
--    SQL statement: the CTE selects with FOR UPDATE SKIP LOCKED, so
--    concurrent workers never see the same row — the second worker
--    skips rows locked by the first. This is what prevents duplicate
--    notifications across processes.
--
--    Returns JSONB payloads (full reminder row + recipient_email from
--    public.users) so the worker does not need a second query.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_due_reminders(p_limit integer DEFAULT 10)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'claim_due_reminders: p_limit must be between 1 and 100';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT id
    FROM public.reminders
    WHERE status = 'pending'
      AND next_attempt_at <= now()
      AND attempts < max_attempts
    ORDER BY next_attempt_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.reminders r
    SET status = 'claimed',
        claimed_at = now(),
        last_attempt_at = now(),
        attempts = r.attempts + 1
    FROM due
    WHERE r.id = due.id
    RETURNING r.*
  )
  SELECT to_jsonb(c) || jsonb_build_object('recipient_email', u.email)
  FROM claimed c
  LEFT JOIN public.users u ON u.id = c.user_id;
END;
$$;

-- ------------------------------------------------------------
-- 7. Crash recovery: claims stuck in `claimed` for too long
--    (worker died between claim and status update) return to
--    `pending` for retry — or straight to `failed` when the
--    attempt budget is exhausted, so nothing loops forever.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.recover_stale_reminders(p_stale_seconds integer DEFAULT 300)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  IF p_stale_seconds IS NULL OR p_stale_seconds < 1 THEN
    RAISE EXCEPTION 'recover_stale_reminders: p_stale_seconds must be >= 1';
  END IF;

  WITH stale AS (
    SELECT id, attempts, max_attempts
    FROM public.reminders
    WHERE status = 'claimed'
      AND claimed_at < now() - make_interval(secs => p_stale_seconds)
    FOR UPDATE SKIP LOCKED
  ),
  recovered AS (
    UPDATE public.reminders r
    SET status = CASE
            WHEN stale.attempts >= stale.max_attempts THEN 'failed'::reminder_status
            ELSE 'pending'::reminder_status
          END,
        claimed_at = NULL,
        next_attempt_at = CASE
            WHEN stale.attempts >= stale.max_attempts THEN r.next_attempt_at
            ELSE now()
          END,
        failed_at = CASE
            WHEN stale.attempts >= stale.max_attempts THEN now()
            ELSE r.failed_at
          END,
        failure_reason = CASE
            WHEN stale.attempts >= stale.max_attempts
              THEN 'Delivery failed: worker interrupted repeatedly.'
            ELSE r.failure_reason
          END
    FROM stale
    WHERE r.id = stale.id
    RETURNING r.id
  )
  SELECT COUNT(*) INTO v_count FROM recovered;

  RETURN v_count;
END;
$$;

-- ------------------------------------------------------------
-- 8. Privileges: worker functions are service_role ONLY.
--    (Anonymous/authenticated roles must never claim or recover
--    reminders on behalf of users.)
-- ------------------------------------------------------------

REVOKE ALL ON FUNCTION public.claim_due_reminders(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_due_reminders(integer) FROM anon;
REVOKE ALL ON FUNCTION public.claim_due_reminders(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_reminders(integer) TO service_role;

REVOKE ALL ON FUNCTION public.recover_stale_reminders(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recover_stale_reminders(integer) FROM anon;
REVOKE ALL ON FUNCTION public.recover_stale_reminders(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_reminders(integer) TO service_role;

-- ============================================================
-- End of 0003_scheduled_reminders.sql
-- ============================================================
