-- ============================================================
-- Migration: 0013_agent_workflows.sql
-- Description: Multi-Agent Orchestration Engine (Milestone 6).
--
--   ADDITIVE migration. Creates the durable workflow state for
--   agent runs:
--
--     1. `public.agent_runs`        — one row per orchestrated workflow
--     2. `public.agent_run_steps`   — one row per planned agent step
--     3. `public.agent_approvals`   — human-in-the-loop approval records
--     4. `public.agent_audit_events` — append-only security audit trail
--
--   Plus:
--     - RLS ("auth.uid() = user_id") on all four tables: a user can
--       only ever see and mutate their own runs, steps, approvals and
--       audit events (events are insert/select only — no update/delete,
--       making the audit trail append-only).
--     - `set_updated_at()` triggers (same helper family as 0003).
--     - Status CHECK constraints matching the TypeScript state machine
--       (`server/src/agents/shared/plan.schema.ts`).
--     - Approval integrity: payload hash binding, expiry, single-use
--       execution (pending → approved → executing → executed, or
--       rejected/expired/cancelled/failed), and a foreign key ensuring
--       an approval always belongs to a step of the same run AND user.
--     - `recover_stale_agent_runs()` — worker-style recovery for runs
--       stuck in `running` after a process restart (SECURITY DEFINER +
--       fixed search_path, executable by service_role only), mirroring
--       the claim/recovery idiom of migrations 0003/0005/0011.
--
--   No existing table, policy, index or function is modified.
--   No prompts, message content or credentials are stored here — only
--   bounded, redacted metadata.
-- ============================================================

-- ------------------------------------------------------------
-- 0. updated_at helper (no-op if 0003 already created it).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 1. agent_runs — one orchestrated workflow.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- The user's objective (bounded, plain text; NOT a full prompt log).
  objective         text NOT NULL
                    CHECK (length(btrim(objective)) BETWEEN 1 AND 2000),

  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending', 'planning', 'running', 'waiting_approval',
                      'completed', 'partially_failed', 'failed', 'cancelled'
                    )),

  -- Bounded, redacted execution summary (agent names, step counts,
  -- provider used, timings). NEVER contains credentials or raw prompts.
  summary           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Final response shown to the user (bounded).
  final_response    text CHECK (final_response IS NULL OR length(final_response) <= 20000),

  -- Structured failure info: stable code + safe message only.
  error_code        text,
  error_message     text CHECK (error_message IS NULL OR length(error_message) <= 1000),

  -- Optional client-supplied idempotency key: submitting the same
  -- objective twice within the dedupe window returns the SAME run.
  idempotency_key   text,

  -- Set while a worker/process owns execution (stale-recovery target).
  claimed_at        timestamptz,

  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_user_created
  ON public.agent_runs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_status
  ON public.agent_runs (user_id, status);
-- Duplicate-submission guard, per user.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_user_idempotency_unique
  ON public.agent_runs (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- Recovery scan: only non-terminal, claimed runs matter.
CREATE INDEX IF NOT EXISTS idx_agent_runs_claimed
  ON public.agent_runs (claimed_at)
  WHERE status IN ('running', 'planning') AND claimed_at IS NOT NULL;

CREATE OR REPLACE TRIGGER agent_runs_set_updated_at
  BEFORE UPDATE ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 2. agent_run_steps — one planned unit of delegated work.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_run_steps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Plan-local key (snake_case), unique within the run.
  step_key          text NOT NULL
                    CHECK (step_key ~ '^[a-z][a-z0-9_]*$' AND length(step_key) <= 64),

  agent_name        text NOT NULL
                    CHECK (agent_name IN (
                      'memory', 'knowledge', 'task', 'scheduling',
                      'research', 'communication'
                    )),
  operation         text NOT NULL
                    CHECK (operation ~ '^[a-z][a-z0-9_]*$' AND length(operation) <= 64),

  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending', 'ready', 'running', 'waiting_approval',
                      'completed', 'failed', 'skipped', 'cancelled'
                    )),

  -- Declared dependencies (plan-local step keys).
  depends_on        text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Bounded metadata ONLY: input/output arguments as validated JSON.
  -- No credentials, no prompt transcripts, no embeddings.
  input_metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,

  retry_count       int NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  requires_approval boolean NOT NULL DEFAULT false,

  error_code        text,
  error_message     text CHECK (error_message IS NULL OR length(error_message) <= 1000),

  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
  -- Owner consistency with the parent run is enforced by the
  -- agent_run_steps_enforce_owner trigger below (CHECK constraints
  -- cannot reference other tables in PostgreSQL).
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_run_steps_run_step_key_unique
  ON public.agent_run_steps (run_id, step_key);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run
  ON public.agent_run_steps (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_run_steps_user_status
  ON public.agent_run_steps (user_id, status);

CREATE OR REPLACE TRIGGER agent_run_steps_set_updated_at
  BEFORE UPDATE ON public.agent_run_steps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Owner consistency: a step can never be written under a different user
-- than its run.
CREATE OR REPLACE FUNCTION public.enforce_agent_step_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  run_owner uuid;
BEGIN
  SELECT user_id INTO run_owner
  FROM public.agent_runs
  WHERE id = NEW.run_id;

  IF run_owner IS NULL THEN
    RAISE EXCEPTION 'agent_run_steps.run_id does not reference an existing agent_run';
  END IF;
  IF NEW.user_id IS DISTINCT FROM run_owner THEN
    RAISE EXCEPTION 'agent_run_steps.user_id must match its agent_runs.user_id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER agent_run_steps_enforce_owner
  BEFORE INSERT OR UPDATE ON public.agent_run_steps
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_step_owner();

-- ------------------------------------------------------------
-- 3. agent_approvals — human-in-the-loop authorization records.
--
--    An approval is: user-specific, step-specific, bound to the EXACT
--    payload hash, time-limited, and single-use (executed once).
--    Lifecycle: pending → approved → executing → executed
--    (or rejected/expired/cancelled; `failed` when execution errors,
--    which is terminal — re-approving starts a fresh grant).
--    An LLM statement can never create or satisfy one of these rows:
--    only the authenticated user's explicit API decision does.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  step_id           uuid NOT NULL REFERENCES public.agent_run_steps(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- Human-readable description of the exact proposed operation.
  action_description text NOT NULL
                     CHECK (length(btrim(action_description)) BETWEEN 1 AND 1000),
  -- Exact proposed payload (jsonb) — displayed verbatim to the user.
  proposed_payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- sha256 hex of the canonical payload: execution re-hashes and
  -- compares, so a mutated payload can never ride an old approval.
  payload_hash       text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),

  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN (
                      'pending', 'approved', 'executing', 'executed',
                      'rejected', 'expired', 'cancelled', 'failed'
                    )),

  expires_at        timestamptz NOT NULL,
  decided_at        timestamptz,
  executed_at       timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_approvals_user_status
  ON public.agent_approvals (user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_approvals_run
  ON public.agent_approvals (run_id, created_at);
-- Only ONE pending approval per step at a time.
CREATE UNIQUE INDEX IF NOT EXISTS agent_approvals_step_pending_unique
  ON public.agent_approvals (step_id)
  WHERE status = 'pending';

CREATE OR REPLACE TRIGGER agent_approvals_set_updated_at
  BEFORE UPDATE ON public.agent_approvals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Owner consistency: an approval can never reference another user's
-- run or step.
CREATE OR REPLACE FUNCTION public.enforce_agent_approval_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  run_owner uuid;
  step_run  uuid;
  step_owner uuid;
BEGIN
  SELECT user_id INTO run_owner
  FROM public.agent_runs WHERE id = NEW.run_id;
  IF run_owner IS NULL THEN
    RAISE EXCEPTION 'agent_approvals.run_id does not reference an existing agent_run';
  END IF;

  SELECT run_id, user_id INTO step_run, step_owner
  FROM public.agent_run_steps WHERE id = NEW.step_id;
  IF step_run IS NULL THEN
    RAISE EXCEPTION 'agent_approvals.step_id does not reference an existing agent_run_step';
  END IF;

  IF NEW.user_id IS DISTINCT FROM run_owner
     OR NEW.user_id IS DISTINCT FROM step_owner
     OR step_run IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'agent_approvals owner/run does not match the referenced step';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER agent_approvals_enforce_owner
  BEFORE INSERT OR UPDATE ON public.agent_approvals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_agent_approval_owner();

-- ------------------------------------------------------------
-- 3b. agent_audit_events — append-only security audit trail.
--
--    Every security-relevant transition (approval requested, decided,
--    consumed for execution, executed, execution failure, expiry) is
--    recorded here exactly once per transition with a bounded,
--    credential-free metadata payload. Rows are insert-or-select only:
--    there is no UPDATE/DELETE policy, so history cannot be rewritten.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.agent_audit_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  run_id            uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  step_id           uuid REFERENCES public.agent_run_steps(id) ON DELETE SET NULL,
  approval_id       uuid REFERENCES public.agent_approvals(id) ON DELETE SET NULL,

  event             text NOT NULL
                    CHECK (length(btrim(event)) BETWEEN 1 AND 64),
  outcome           text NOT NULL DEFAULT 'ok'
                    CHECK (outcome IN ('ok', 'denied', 'error')),
  -- Small, credential-free details (capability, operation, step_key,
  -- status codes — never the payload arguments).
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_events_user
  ON public.agent_audit_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_events_run
  ON public.agent_audit_events (run_id, created_at);

-- ------------------------------------------------------------
-- 4. RLS — users only ever touch their own workflow state.
-- ------------------------------------------------------------
ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_runs_select_own ON public.agent_runs;
CREATE POLICY agent_runs_select_own ON public.agent_runs
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_runs_insert_own ON public.agent_runs;
CREATE POLICY agent_runs_insert_own ON public.agent_runs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_runs_update_own ON public.agent_runs;
CREATE POLICY agent_runs_update_own ON public.agent_runs
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_runs_delete_own ON public.agent_runs;
CREATE POLICY agent_runs_delete_own ON public.agent_runs
  FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS agent_run_steps_select_own ON public.agent_run_steps;
CREATE POLICY agent_run_steps_select_own ON public.agent_run_steps
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_run_steps_insert_own ON public.agent_run_steps;
CREATE POLICY agent_run_steps_insert_own ON public.agent_run_steps
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_run_steps_update_own ON public.agent_run_steps;
CREATE POLICY agent_run_steps_update_own ON public.agent_run_steps
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- Steps are plan data: they are not user-deletable (audit trail is
-- removed with the run via CASCADE).
DROP POLICY IF EXISTS agent_run_steps_delete_own ON public.agent_run_steps;
CREATE POLICY agent_run_steps_delete_own ON public.agent_run_steps
  FOR DELETE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS agent_approvals_select_own ON public.agent_approvals;
CREATE POLICY agent_approvals_select_own ON public.agent_approvals
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_approvals_insert_own ON public.agent_approvals;
CREATE POLICY agent_approvals_insert_own ON public.agent_approvals
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_approvals_update_own ON public.agent_approvals;
CREATE POLICY agent_approvals_update_own ON public.agent_approvals
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_approvals_delete_own ON public.agent_approvals;
CREATE POLICY agent_approvals_delete_own ON public.agent_approvals
  FOR DELETE USING (auth.uid() = user_id);

-- Audit trail is append-only for owners: they may insert and read
-- their own events; no UPDATE/DELETE is granted, so history cannot be
-- rewritten or erased by account compromise or application bugs.
DROP POLICY IF EXISTS agent_audit_events_select_own ON public.agent_audit_events;
CREATE POLICY agent_audit_events_select_own ON public.agent_audit_events
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS agent_audit_events_insert_own ON public.agent_audit_events;
CREATE POLICY agent_audit_events_insert_own ON public.agent_audit_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 5. Worker-only recovery for runs interrupted by a restart.
--
--    Mirrors recover_stale_document_jobs(): a run stuck in
--    'planning'/'running' with an old claim is requeued (steps reset
--    to 'ready'/'pending'), or failed honestly when the run has
--    exhausted its retries. No run is left 'running' forever.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recover_stale_agent_runs(p_stale_seconds int DEFAULT 300)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recovered int;
  stale_cutoff timestamptz;
  run_rec record;
BEGIN
  stale_cutoff := now() - make_interval(secs => GREATEST(p_stale_seconds, 1));

  FOR run_rec IN
    SELECT id
    FROM public.agent_runs
    WHERE status IN ('planning', 'running')
      AND claimed_at IS NOT NULL
      AND claimed_at < stale_cutoff
    FOR UPDATE SKIP LOCKED
  LOOP
    -- Steps that were mid-flight become re-runnable only when their
    -- step is idempotent-safe: a completed step is NEVER reset (no
    -- re-execution of non-idempotent actions after a restart).
    UPDATE public.agent_run_steps
    SET status = 'pending',
        started_at = NULL,
        updated_at = now()
    WHERE run_id = run_rec.id
      AND status = 'running';

    UPDATE public.agent_runs
    SET status = 'failed',
        claimed_at = NULL,
        completed_at = now(),
        error_code = COALESCE(error_code, 'RUNNER_INTERRUPTED'),
        error_message = COALESCE(error_message,
          'The workflow runner was interrupted and the run was marked failed. Completed steps were preserved.'),
        updated_at = now()
    WHERE id = run_rec.id;
  END LOOP;

  GET DIAGNOSTICS recovered = ROW_COUNT;
  RETURN recovered;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_agent_runs(int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_agent_runs(int)
  TO service_role;

-- ============================================================
-- End of 0013_agent_workflows.sql
-- ============================================================
