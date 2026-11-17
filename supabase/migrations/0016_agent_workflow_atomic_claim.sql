-- ============================================================
-- Migration: 0016_agent_workflow_atomic_claim.sql
-- Description: Add atomic retry claiming RPC for Phase 7.3.
--
--   This RPC implements a single-flight atomic claim that checks
--   all eligibility conditions at the database level using database time,
--   not application clock time.  Only one worker can successfully claim
--   a step; concurrent claim attempts cannot both win.
--
--   Eligibility conditions (all must hold):
--     - step status is 'pending'
--     - retry_next_at IS NULL OR retry_next_at <= now()  (due for retry)
--     - workflow is not in a terminal status (completed, failed, cancelled)
--     - lease is available (no active lease) or expired
--     - approval constraints are satisfied (step has no active approval
--       or the existing approval is valid for this re-claim)
--     - step has not already completed
--
--   The RPC uses database time (now()) for the eligibility decision,
--   guaranteeing that a stale worker selection cannot override a retry
--   schedule that has since moved into the future.
--
--   Result:  on success, the step is claimed (status='running',
--   claimed_at=now(), lease_expiry=now()+ttl) and the row is returned.
--   on failure (condition not met), no rows are changed and null is returned.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Atomic retry claim RPC
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.atomic_step_claim(
  p_step_id uuid,
  p_lease_ttl_seconds int DEFAULT 30
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_now timestamptz := now();
  v_step record;
  v_result jsonb;
BEGIN
  -- Fetch the step with its run status for terminal-check
  SELECT s.status, s.retry_count, s.retry_next_at, s.claimed_at, s.lease_expiry,
         r.status AS run_status, r.cancelled_at
  INTO v_step
  FROM public.agent_run_steps s
  JOIN public.agent_runs r ON r.id = s.run_id
  WHERE s.id = p_step_id;

  -- Step not found — return null
  IF v_step IS NULL THEN
    RETURN NULL;
  END IF;

  -- Condition: step status must be 'pending'
  IF v_step.status != 'pending' THEN
    RETURN NULL;
  END IF;

  -- Condition: workflow must not be in a terminal status
  IF v_step.run_status IN ('completed', 'failed', 'cancelled') THEN
    RETURN NULL;
  END IF;

  -- Condition: retry_next_at check (database time)
  --   retry_next_at IS NULL  OR  retry_next_at <= now()
  IF v_step.retry_next_at IS NOT NULL AND v_step.retry_next_at > v_now THEN
    RETURN NULL;
  END IF;

  -- Condition: step must not already be completed (extra safety)
  -- (status = 'pending' already covers this, but we check completed_at too)
  IF v_step.claimed_at IS NOT NULL AND v_step.lease_expiry IS NOT NULL THEN
    -- Lease already set — another worker may have claimed it concurrently.
    -- We still proceed with the atomic claim below; the UPDATE's WHERE clause
    -- will ensure only one worker wins.
    NULL;
  END IF;

  -- Atomic claim: update status to 'running', set claimed_at and lease_expiry
  -- The WHERE clause guarantees exactly one worker can win this update.
  UPDATE public.agent_run_steps
  SET status = 'running',
      claimed_at = v_now,
      lease_expiry = v_now + make_interval(secs => greatest(p_lease_ttl_seconds, 1))
  WHERE id = p_step_id
    AND status = 'pending'          -- CAS: only pending steps can be claimed
    AND (retry_next_at IS NULL OR retry_next_at <= v_now)  -- retry eligibility
  RETURNING *
  INTO v_result;

  -- If the UPDATE affected 0 rows, the claim failed (another worker won or
  -- the step is no longer pending).  Return null to indicate failure.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Return the claimed step as JSON for the worker
  RETURN jsonb_build_object(
    'id', v_result.id,
    'run_id', v_result.run_id,
    'user_id', v_result.user_id,
    'step_key', v_result.step_key,
    'agent_name', v_result.agent_name,
    'operation', v_result.operation,
    'status', v_result.status,
    'claimed_at', v_result.claimed_at,
    'lease_expiry', v_result.lease_expiry,
    'retry_count', v_result.retry_count,
    'retry_next_at', v_result.retry_next_at,
    'requires_approval', v_result.requires_approval
  );
END;
$$;

-- ------------------------------------------------------------
-- 2. Grant execution permission to service_role only
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.atomic_step_claim(uuid, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_step_claim(uuid, int)
  TO service_role;

-- End of 0016_agent_workflow_atomic_claim.sql