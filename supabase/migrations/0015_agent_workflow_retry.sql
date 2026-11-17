-- ============================================================
-- Migration: 0015_agent_workflow_retry.sql
-- Description: Add retry scheduling column for Phase 7.2.
--
--   Add `retry_next_at` to `agent_run_steps` so that the recovery
--   worker can enforce eligibility: a step with a future
--   `retry_next_at` must not be claimed; only steps where
--   `retry_next_at IS NULL OR retry_next_at <= now()` are claimable.
--
--   This column is additive — existing runs and steps are not
--   affected (NULL-valued before this migration).
-- ============================================================

-- ------------------------------------------------------------
-- 1. retry_next_at — when this step becomes eligible for retry.
--    The recovery worker will not claim a step whose
--    retry_next_at is in the future.  NULL means the step
--    is eligible for immediate re-claim (first attempt or
--    no-retry path).
-- ------------------------------------------------------------
ALTER TABLE public.agent_run_steps
  ADD COLUMN retry_next_at timestamptz;

-- ------------------------------------------------------------
-- 2. Index: support fast lookup of due retries.
--    The worker tick queries for steps where
--    status = 'pending' AND retry_next_at <= now().
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_retry_due
  ON public.agent_run_steps (retry_next_at)
  WHERE retry_next_at IS NOT NULL;

-- ------------------------------------------------------------
-- 3. Update existing retry rows from the extraction scheduler
--    (if any) to populate retry_next_at from the existing
--    retry_count / computeBackoffMs logic.  This is a best-effort
--    backfill; rows with NULL retry_next_at remain eligible
--    for immediate re-claim.
-- ------------------------------------------------------------
-- NOTE: The backfill is intentionally omitted from the migration
--       because the existing extraction scheduler uses a different
--       column naming convention.  Runners that need the backfill
--       can add it as a separate data-fix step.
-- ------------------------------------------------------------

-- End of 0015_agent_workflow_retry.sql