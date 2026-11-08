-- ============================================================
-- Migration: 0009_match_memories_hybrid_lexical.sql
-- Description: Milestone 4.2 retrieval-quality improvement.
--
--   1. `match_memories` gains an optional `p_query_text` argument and
--      performs HYBRID retrieval:
--        - vector candidates: cosine similarity >= match_threshold
--        - lexical candidates: PostgreSQL full-text match on the query
--      Lexical matches are included even when their cosine score is
--      below the threshold (that is the point of hybrid search), and
--      they rank before non-lexical vector hits. Ties fall back to
--      cosine similarity.
--   2. Adds a GIN full-text index so lexical candidates do not require
--      a sequential scan.
--   3. Grants EXECUTE to BOTH `authenticated` (API requests) and
--      `service_role` (background extraction worker). The 0008 version
--      granted only `authenticated`, which silently disabled the
--      worker's conflict detection (the RPC failed and retrieval
--      degraded to "no existing memories found").
--
-- Backward compatibility: all previous arguments keep their defaults,
-- so 4- and 5-argument calls are still valid with `p_query_text = NULL`
-- (pure vector behaviour).
--
-- User isolation is unchanged: SECURITY INVOKER + `m.user_id = p_user_id`.
--
-- Requires: 0005, 0008. Idempotent.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Full-text index for lexical candidates.
--    `to_tsvector(regconfig, text)` is IMMUTABLE, so it is indexable.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_memories_content_fts
  ON public.memories
  USING gin (to_tsvector('english', content));

COMMENT ON INDEX public.idx_memories_content_fts IS
  'GIN index supporting hybrid lexical matching in match_memories().';

-- ------------------------------------------------------------
-- 2. Replace match_memories with the hybrid version.
--    DROP is required to change the signature; defaults keep older
--    calls valid.
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS public.match_memories(vector, uuid, float, int, text);

CREATE OR REPLACE FUNCTION public.match_memories(
  query_embedding vector(1536),
  p_user_id uuid,
  match_threshold float DEFAULT 0.65,
  match_count int DEFAULT 8,
  p_category text DEFAULT NULL,
  p_query_text text DEFAULT NULL
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
  WITH filtered AS (
    SELECT
      m.id,
      m.user_id,
      m.content,
      m.category,
      m.created_at,
      m.embedding,
      1 - (m.embedding <=> query_embedding) AS cosine
    FROM public.memories m
    WHERE m.user_id = p_user_id
      AND m.status = 'active'
      AND m.superseded_by IS NULL
      AND (m.expired_at IS NULL OR m.expired_at > now())
      AND m.sensitivity <> 'credential'
      AND m.embedding IS NOT NULL
      AND (p_category IS NULL OR m.category::text = p_category)
  ),
  vector_hits AS (
    SELECT f.*, false AS lexical
    FROM filtered f
    WHERE f.cosine >= match_threshold
    ORDER BY f.embedding <=> query_embedding
    LIMIT LEAST(GREATEST(match_count, 1), 50)
  ),
  lexical_hits AS (
    SELECT f.*, true AS lexical
    FROM filtered f
    WHERE p_query_text IS NOT NULL
      AND btrim(p_query_text) <> ''
      AND to_tsvector('english', f.content)
          @@ plainto_tsquery('english', p_query_text)
    ORDER BY f.cosine DESC
    LIMIT LEAST(GREATEST(match_count, 1), 50)
  ),
  combined AS (
    SELECT id, user_id, content, category, created_at, cosine, lexical FROM vector_hits
    UNION ALL
    SELECT id, user_id, content, category, created_at, cosine, lexical FROM lexical_hits
  ),
  dedup AS (
    SELECT
      id,
      user_id,
      content,
      category,
      created_at,
      max(cosine) AS cosine,
      bool_or(lexical) AS lexical
    FROM combined
    GROUP BY id, user_id, content, category, created_at
  )
  SELECT
    d.id AS memory_id,
    d.user_id,
    d.content,
    d.category::text AS category,
    d.cosine::float AS similarity,
    d.created_at
  FROM dedup d
  ORDER BY d.lexical DESC, d.cosine DESC
  LIMIT LEAST(GREATEST(match_count, 1), 50);
$$;

COMMENT ON FUNCTION public.match_memories(vector, uuid, float, int, text, text) IS
  'Hybrid memory search scoped to the verified user: vector similarity OR full-text lexical match when p_query_text is supplied. p_category optionally narrows results; NULL means all categories. similarity is raw cosine similarity.';

-- Re-apply least-privilege grants (DROP removed them).
REVOKE ALL ON FUNCTION public.match_memories(vector, uuid, float, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_memories(vector, uuid, float, int, text, text)
  TO authenticated, service_role;

COMMIT;
