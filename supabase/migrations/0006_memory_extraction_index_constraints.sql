-- ============================================================
-- Migration: 0006_memory_extraction_index_constraints.sql
-- Description: EXACT content dedupe constraint for Milestone 4.1.
--              The match_memories() function signature already accepts
--              provider/model/category filter args in 0005; this migration
--              adds a partial unique index so two identical user
--              statements never produce two identical memories
--              (active + needs_review rows). The duplicate-detection
--              fallback handler (23505) stays as an app-layer safety net.
-- Requires: pgvector (applied via 0005). Idempotent: IF NOT EXISTS.
-- ============================================================

-- ------------------------------------------------------------
-- Partial unique index: exact content dedupe for active + review rows.
-- Covers both status values so repeated identical user statements do not
-- create duplicate memories even across extraction retries.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS memories_user_content_unique_idx
ON memories (user_id, content)
WHERE status IN ('active', 'needs_review');
