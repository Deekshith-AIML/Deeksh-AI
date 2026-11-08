-- ============================================================
-- Migration: 0005_memory_engine.sql
-- Description: Hybrid long-term memory engine (Milestone 4).
-- Requires: pgvector extension available on the target database.
--   If not present locally: CREATE EXTENSION will fail; apply after
--   enabling the extension on the hosted/project DB.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Extension prerequisite (verified separately; see M4 audit)
-- ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------
-- 2. Memory categories
-- ------------------------------------------------------------
CREATE TYPE memory_category AS ENUM (
  'personal_fact',
  'user_preference',
  'career_goal',
  'project',
  'important_event',
  'learning_preference',
  'work_info',
  'recurring_info',
  'other'
);

-- ------------------------------------------------------------
-- 3. User memories (durable PostgreSQL table with RLS + vector)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memories (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  content             text NOT NULL,
  content_summary     text,  -- brief summary for display/retrieval context
  category            memory_category NOT NULL DEFAULT 'personal_fact',
  embedding           vector(1536),  -- Gemini Embedding 2; 1536 dims locked
  embedding_provider  text NOT NULL DEFAULT 'gemini',
  embedding_model_version text NOT NULL DEFAULT 'gemini-embedding-2',
  embedding_dimensions int NOT NULL DEFAULT 1536,

  -- Provenance (links back to messages table; no fabricated conversation_id)
  source_message_id   uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  source_evidence     text,  -- brief quote / evidence (max 500 chars, sanitized)

  -- Metadata / lifecycle
  confidence          text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low', 'medium', 'high')),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_review', 'superseded', 'expired', 'deleted')),
  superseded_by       uuid REFERENCES public.memories(id) ON DELETE SET NULL,
  supersession_confirmed_by_user boolean NOT NULL DEFAULT false,

  -- Sensitivity / privacy
  sensitivity         text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive', 'credential')),

  -- Timestamps
  extraction_timestamp timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_accessed_at      timestamptz,

  -- Optional expiration
  expired_at            timestamptz,

  -- Constraints / indexes
  CONSTRAINT memory_embedding_dim CHECK (embedding_dimensions = 1536)  -- never change dims
);

COMMENT ON TABLE public.memories IS
  'User-owned long-term memory records. Each memory is tied to a verified user (user_id from auth, never from client input). Vector embeddings use 1536-dimension Gemini Embedding 2. Source provenance links to public.messages.id (user message only, never fabricated conversation ids). Sensitive/credential categories protected. RLS enforced.';

COMMENT ON COLUMN public.memories.embedding IS
  '1536-dimension embedding from primary provider (gemini-embedding-2). Dimension locked by CHECK + default. Provider/model/dimension recorded for audit.';
COMMENT ON COLUMN public.memories.sensitivity IS
  'Privacy classification: normal (default chat context allowed with user settings), sensitive (explicit safeguards; not automatic prompt injection by default), credential (blocked by extraction; never saved).';
COMMENT ON COLUMN public.memories.status IS
  'Lifecycle: active (usable), needs_review (conflict/supersession pending user confirmation), superseded (replaced by superseded_by), expired (past expired_at), deleted (soft/hard). No silent supersession; supersession_confirmed_by_user required for supersession promotion.';

-- Vector similarity index: HNSW with cosine ops.
-- Chosen over ivfflat AFTER live evaluation (see
-- supabase/local-dev/eval_match_memories.sql): ivfflat produced low recall
-- on small tables (pgvector's own build-time NOTICE: "ivfflat index created
-- with little data — This will cause low recall"). HNSW has no training
-- phase and good recall at all table sizes. Non-partial: pgvector indexes
-- do not support partial predicates; status/ownership/sensitivity filters
-- are applied in match_memories().
CREATE INDEX IF NOT EXISTS idx_memories_embedding_cosine
  ON public.memories USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_memories_user_category_active
  ON public.memories (user_id, category, status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memories_source_message
  ON public.memories (source_message_id) WHERE source_message_id IS NOT NULL;

-- ------------------------------------------------------------
-- 4. Memory settings / preferences (user-controlled consent)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_settings (
  user_id                   uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  automatic_memory_extraction boolean NOT NULL DEFAULT false,
  similarity_threshold        float NOT NULL DEFAULT 0.65 CHECK (similarity_threshold >= 0.0 AND similarity_threshold <= 1.0),
  include_memory_in_chat      boolean NOT NULL DEFAULT true,
  include_sensitive_in_chat   boolean NOT NULL DEFAULT false,
  max_memory_context_chars    int NOT NULL DEFAULT 1500 CHECK (max_memory_context_chars > 0),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.memory_settings.automatic_memory_extraction IS
  'User consent control: default FALSE for new users (must opt in). Explicit "Remember..." commands work regardless of this setting. Disabling does NOT delete existing memories (only stops automatic extraction).';
COMMENT ON COLUMN public.memory_settings.include_memory_in_chat IS
  'Whether retrieved memories are injected into chat prompts. Independent of extraction setting. Memory content is untrusted context payload, not instruction (see prompt isolation rules).';
COMMENT ON COLUMN public.memory_settings.include_sensitive_in_chat IS
  'Whether sensitive memories may be included in chat context. Default FALSE. Never enabled automatically; requires explicit user authorization.';

-- ------------------------------------------------------------
-- 5. Memory extraction outbox (durable worker mechanism)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_extraction_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  claimed_at      timestamptz,
  attempts        int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failed_at       timestamptz,
  error_message   text,
  result_memory_ids uuid[] DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.memory_extraction_jobs IS
  'Durable extraction outbox: claims are atomic (SELECT FOR UPDATE SKIP LOCKED). Background worker claims pending rows, runs extraction, updates job (completed with result_memory_ids, or failed with error_message). Chat responses never blocked by extraction failures. No external queue (Redis) required; PostgreSQL is the durable outbox.';

CREATE INDEX IF NOT EXISTS idx_extraction_jobs_claim
  ON public.memory_extraction_jobs (status, claimed_at, attempts)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_extraction_jobs_user_pending
  ON public.memory_extraction_jobs (user_id, status);

-- ------------------------------------------------------------
-- 6. RLS policies (additive to existing policies from 0001–0004)
--    Explicit grants (same pattern as 0004): the API role is
--    constrained by RLS; service_role bypasses RLS for the worker.
--    Without these, access fails with "permission denied" before
--    RLS is ever evaluated.
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memories
  TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_settings
  TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memory_extraction_jobs
  TO authenticated, service_role;

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memories_select_own ON public.memories;
CREATE POLICY memories_select_own ON public.memories
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS memories_insert_own ON public.memories;
CREATE POLICY memories_insert_own ON public.memories
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS memories_update_own ON public.memories;
CREATE POLICY memories_update_own ON public.memories
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS memories_delete_own ON public.memories;
CREATE POLICY memories_delete_own ON public.memories
  FOR DELETE USING (auth.uid() = user_id);

ALTER TABLE public.memory_extraction_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS extraction_select_own ON public.memory_extraction_jobs;
CREATE POLICY extraction_select_own ON public.memory_extraction_jobs
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS extraction_insert_own ON public.memory_extraction_jobs;
CREATE POLICY extraction_insert_own ON public.memory_extraction_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS extraction_update_own ON public.memory_extraction_jobs;
CREATE POLICY extraction_update_own ON public.memory_extraction_jobs
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS extraction_delete_own ON public.memory_extraction_jobs;
CREATE POLICY extraction_delete_own ON public.memory_extraction_jobs
  FOR DELETE USING (auth.uid() = user_id);

ALTER TABLE public.memory_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_settings_select_own ON public.memory_settings;
CREATE POLICY memory_settings_select_own ON public.memory_settings
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS memory_settings_insert_own ON public.memory_settings;
CREATE POLICY memory_settings_insert_own ON public.memory_settings
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS memory_settings_update_own ON public.memory_settings;
CREATE POLICY memory_settings_update_own ON public.memory_settings
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS memory_settings_delete_own ON public.memory_settings;
CREATE POLICY memory_settings_delete_own ON public.memory_settings
  FOR DELETE USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 7. Updated-at trigger (reuse from 0004)
-- ------------------------------------------------------------
CREATE TRIGGER memories_set_updated_at
  BEFORE UPDATE ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER extraction_set_updated_at
  BEFORE UPDATE ON public.memory_extraction_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER memory_settings_set_updated_at
  BEFORE UPDATE ON public.memory_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 8. Vector similarity search function (called via Supabase RPC)
--    Per instruction 2: SECURITY INVOKER (RLS still applies to the
--    caller), hardened search_path, bounded results, ownership
--    filter on the verified user id, excludes deleted/expired/
--    superseded/credential rows.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_memories(
  query_embedding vector(1536),
  p_user_id uuid,
  match_threshold float DEFAULT 0.65,
  match_count int DEFAULT 8
)
RETURNS TABLE (
  memory_id uuid,
  user_id uuid,
  content text,
  category text,
  similarity float,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    m.id AS memory_id,
    m.user_id,
    m.content,
    m.category::text AS category,
    1 - (m.embedding <=> query_embedding) AS similarity,
    m.created_at
  FROM public.memories m
  WHERE m.user_id = p_user_id
    AND m.status = 'active'
    AND m.superseded_by IS NULL
    AND (m.expired_at IS NULL OR m.expired_at > now())
    AND m.sensitivity <> 'credential'
    AND m.embedding IS NOT NULL
    AND (1 - (m.embedding <=> query_embedding)) >= match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 50);
$$;

-- Safe function permissions: no PUBLIC execute; only authenticated users
-- (invoked through the user-scoped client, so RLS applies on top).
REVOKE ALL ON FUNCTION public.match_memories(vector, uuid, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_memories(vector, uuid, float, int) TO authenticated;

-- ------------------------------------------------------------
-- 9. Durable extraction outbox functions (instruction 9)
--    Atomic claim (FOR UPDATE SKIP LOCKED) so two workers can never
--    process the same job. SECURITY DEFINER is NECESSARY here: the
--    background worker claims jobs across all users, bypassing RLS.
--    Hardened: fixed search_path, no PUBLIC execute, service_role only.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_memory_extraction_jobs(p_limit int DEFAULT 5)
RETURNS SETOF public.memory_extraction_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- First recover stale claims so interrupted jobs become claimable again.
  UPDATE public.memory_extraction_jobs
  SET status = 'pending', claimed_at = NULL, updated_at = now()
  WHERE status = 'claimed'
    AND claimed_at IS NOT NULL
    AND claimed_at < now() - interval '300 seconds';

  -- Then atomically claim pending jobs (SKIP LOCKED prevents duplicates).
  RETURN QUERY
  UPDATE public.memory_extraction_jobs j
  SET status = 'claimed',
      claimed_at = now(),
      attempts = j.attempts + 1,
      updated_at = now()
  WHERE j.id IN (
    SELECT id FROM public.memory_extraction_jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT LEAST(GREATEST(p_limit, 1), 20)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING j.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_stale_extraction_jobs(p_stale_seconds int DEFAULT 300)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recovered int;
BEGIN
  UPDATE public.memory_extraction_jobs
  SET status = 'pending', claimed_at = NULL, updated_at = now()
  WHERE status = 'claimed'
    AND claimed_at IS NOT NULL
    AND claimed_at < now() - (make_interval(secs => GREATEST(p_stale_seconds, 1)));
  GET DIAGNOSTICS recovered = ROW_COUNT;
  RETURN recovered;
END;
$$;

-- Worker-only functions: never exposed to end users (anon/authenticated).
REVOKE ALL ON FUNCTION public.claim_memory_extraction_jobs(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_memory_extraction_jobs(int) TO service_role;

REVOKE ALL ON FUNCTION public.recover_stale_extraction_jobs(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_extraction_jobs(int) TO service_role;

-- ============================================================
-- End of 0005_memory_engine.sql
-- ============================================================
