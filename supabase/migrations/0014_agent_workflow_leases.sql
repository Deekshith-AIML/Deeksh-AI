-- ============================================================
-- Migration: 0014_agent_workflow_leases.sql
-- Description: Add lease management columns for Phase 7.
--
--   Add `claimed_at` and `lease_expiry` to `agent_run_steps`
--   so that the workflow recovery worker can atomically claim
--   steps using FOR UPDATE SKIP LOCKED-equivalent semantics,
--   persist lease TTL, and support stale-run recovery.
--
--   These columns are additive — existing runs and steps are
--   not affected (null-valued before this migration).
-- ============================================================

-- ------------------------------------------------------------
-- 1. claimed_at — when a worker claimed the step (NULL when unclaimed / pending)
-- ------------------------------------------------------------
ALTER TABLE public.agent_run_steps
  ADD COLUMN claimed_at timestamptz;

-- ------------------------------------------------------------
-- 2. lease_expiry — when this lease expires; step becomes
--    eligible for re-claim once claimed_at + leaseTtlSeconds
--    has elapsed (default 30s in the worker config).
-- ------------------------------------------------------------
ALTER TABLE public.agent_run_steps
  ADD COLUMN lease_expiry timestamptz;

-- ------------------------------------------------------------
-- 3. Index: support fast lookup of claimed steps for recovery.
--    We only index non-NULL claimed_at rows; the recover_stale_agent_runs
--    RPC already handles the stale-check logic.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_claimed_at
  ON public.agent_run_steps (claimed_at)
  WHERE claimed_at IS NOT NULL;

-- ------------------------------------------------------------
-- 4. A note: the existing recover_stale_agent_runs() RPC from
--    migration 0013 already knows how to return stale runs to
--    'pending'.  These new columns are used by claimStepLease
--    and the workflow worker tick; the RPC remains the primary
--    recovery mechanism for worker-crash scenarios.
-- ------------------------------------------------------------

-- End of 0014_agent_workflow_leases.sql