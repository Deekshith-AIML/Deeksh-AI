-- ============================================================
-- Migration: 0008_match_memories_category_and_conflict_link.sql
-- Description: Forward-only Milestone 4.1 additions.
--
--   1. `match_memories` gains an optional `p_category` filter. The
--      previous 4-argument signature is replaced by a 5-argument
--      function whose last argument defaults to NULL, so existing
--      4-argument RPC calls remain valid.
--   2. `memories.conflict_with` links a `needs_review` row to the
--      existing memory it contradicts, enabling a side-by-side
--      comparison in the dashboard without re-running similarity.
--
-- User isolation is unchanged: `match_memories` remains SECURITY
-- INVOKER and still filters on `p_user_id`.
--
-- Requires: 0005, 0007. Idempotent.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Conflict provenance for review rows.
-- ------------------------------------------------------------
ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS conflict_with uuid
  REFERENCES public.memories(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.memories.conflict_with IS
  'For status=needs_review: the existing memory this row contradicts. NULL for normal rows. Set by the conflict detector; cleared when the user confirms supersession.';

CREATE INDEX IF NOT EXISTS idx_memories_conflict_with
  ON public.memories (conflict_with)
  WHERE conflict_with IS NOT NULL;

-- ------------------------------------------------------------
-- 2. Replace match_memories with a category-aware version.
--    DROP is required because PostgreSQL cannot change a function
--    signature with CREATE OR REPLACE; the default keeps 4-arg
--    callers backward compatible.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.match_memories(vector, uuid, float, int);

CREATE OR REPLACE FUNCTION public.match_memories(
  query_embedding vector(1536),
  p_user_id uuid,
  match_threshold float DEFAULT 0.65,
  match_count int DEFAULT 8,
  p_category text DEFAULT NULL
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
    AND (p_category IS NULL OR m.category::text = p_category)
    AND (1 - (m.embedding <=> query_embedding)) >= match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 50);
$$;

COMMENT ON FUNCTION public.match_memories(vector, uuid, float, int, text) IS
  'Cosine-similarity memory search scoped to the verified user. p_category optionally narrows results; NULL means all categories.';

-- Re-apply least-privilege grants (DROP removed them).
REVOKE ALL ON FUNCTION public.match_memories(vector, uuid, float, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_memories(vector, uuid, float, int, text) TO authenticated;

COMMIT;
