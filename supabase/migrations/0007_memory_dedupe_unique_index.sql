-- ============================================================
-- Migration: 0007_memory_dedupe_unique_index.sql
-- Description: Forward-only repair of Milestone 4.1 deduplication.
--
--   Migration 0006 created a NON-UNIQUE index
--   (`memories_user_content_unique_idx`) while claiming it was a
--   partial UNIQUE index. This migration:
--     1. audits every existing exact duplicate,
--     2. preserves history by marking later duplicates `superseded`
--        (never deleting them) and linking them to the kept row,
--     3. replaces the non-unique index with the intended partial
--        UNIQUE index,
--     4. verifies that no duplicate active/needs_review rows remain.
--
-- Historical, superseded, expired and deleted rows are OUTSIDE the
-- partial index predicate, so history is never affected.
--
-- Idempotent: safe to re-run. Requires: 0005 (memories), 0006.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Durable audit trail for rows resolved by this migration.
--    Service-role only (RLS enabled, no policies): this is an
--    operational record, not user-facing content.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_dedupe_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kept_memory_id      uuid NOT NULL,
  duplicate_memory_id uuid NOT NULL,
  content             text NOT NULL,
  resolution          text NOT NULL,
  resolved_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.memory_dedupe_audit IS
  'Audit of exact-duplicate memories resolved by migration 0007. Duplicates are superseded, never deleted.';

ALTER TABLE public.memory_dedupe_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.memory_dedupe_audit FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Resolve existing duplicates (active + needs_review only).
--    Keeper preference: active first, then oldest created_at, then id.
-- ------------------------------------------------------------
DO $$
DECLARE
  dup       RECORD;
  keeper_id uuid;
  loser     RECORD;
BEGIN
  FOR dup IN
    SELECT user_id, content
    FROM public.memories
    WHERE status IN ('active', 'needs_review')
    GROUP BY user_id, content
    HAVING count(*) > 1
  LOOP
    SELECT m.id
      INTO keeper_id
      FROM public.memories m
     WHERE m.user_id = dup.user_id
       AND m.content = dup.content
       AND m.status IN ('active', 'needs_review')
     ORDER BY (m.status = 'active') DESC, m.created_at ASC, m.id ASC
     LIMIT 1;

    FOR loser IN
      SELECT m.id
        FROM public.memories m
       WHERE m.user_id = dup.user_id
         AND m.content = dup.content
         AND m.status IN ('active', 'needs_review')
         AND m.id <> keeper_id
       ORDER BY m.created_at ASC, m.id ASC
    LOOP
      INSERT INTO public.memory_dedupe_audit
        (user_id, kept_memory_id, duplicate_memory_id, content, resolution)
      VALUES
        (dup.user_id, keeper_id, loser.id, dup.content, 'exact_duplicate_superseded');

      -- Preserve the row (history) but take it out of the searchable set.
      UPDATE public.memories
         SET status = 'superseded',
             superseded_by = keeper_id,
             supersession_confirmed_by_user = false,
             updated_at = now()
       WHERE id = loser.id;
    END LOOP;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 3. Replace the non-unique index with the intended partial UNIQUE index.
-- ------------------------------------------------------------
DROP INDEX IF EXISTS public.memories_user_content_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS memories_user_content_unique_idx
  ON public.memories (user_id, content)
  WHERE status IN ('active', 'needs_review');

COMMENT ON INDEX public.memories_user_content_unique_idx IS
  'Partial UNIQUE index: at most one active/needs_review memory per (user_id, exact content). Superseded/expired/deleted history is excluded.';

-- ------------------------------------------------------------
-- 4. Verify: fail the migration if any duplicate remains.
-- ------------------------------------------------------------
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT count(*) INTO remaining
    FROM (
      SELECT 1
        FROM public.memories
       WHERE status IN ('active', 'needs_review')
       GROUP BY user_id, content
      HAVING count(*) > 1
    ) d;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Migration 0007 verification failed: % duplicate (user_id, content) group(s) still present.',
      remaining;
  END IF;
END $$;

COMMIT;
