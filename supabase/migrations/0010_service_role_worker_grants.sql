-- ============================================================
-- Migration: 0010_service_role_worker_grants.sql
-- Description: grant the trusted backend worker the minimum table
--              privileges it needs (Milestone 4.2 stabilization).
--
-- WHY THIS EXISTS
-- The reminder + extraction workers run in their own process with
-- SUPABASE_SERVICE_ROLE_KEY (createAdminClient) because they must read
-- work across ALL users and persist delivery/extraction status. RLS
-- user-scoped clients cannot do that.
--
-- Migrations 0001-0008 granted table privileges to `authenticated`
-- (and the memory tables also to `service_role` because migrations
-- 0004-0008 were written after the worker existed). The remaining
-- worker-read tables were never granted to `service_role`:
--
--   * messages  -> extraction worker reads the source turn (SELECT)
--   * reminders -> reminder worker persists delivery status (SELECT, UPDATE)
--
-- On a Supabase-managed project the platform's default privileges
-- usually hide this. On plain PostgreSQL (including the repo's local
-- dev harness) the worker receives:
--   "permission denied for table messages"
-- and every extraction job fails with "Message not found.", while
-- reminder status updates fail silently. This migration removes that
-- environment dependency.
--
-- LEAST PRIVILEGE: only SELECT where a worker only reads, and
-- SELECT + UPDATE where it must persist a status. No DELETE, no
-- INSERT, no new tables, no RLS changes. `authenticated` grants are
-- unchanged, so cross-user API isolation is unaffected.
--
-- Idempotent. Requires: 0001 (messages), 0003 (reminders).
-- ============================================================

BEGIN;

GRANT SELECT ON TABLE public.messages TO service_role;

GRANT SELECT, UPDATE ON TABLE public.reminders TO service_role;

-- Defensive re-assertion for the memory tables the extraction worker
-- already used (0004-0008 granted these; keep the worker path whole
-- even if those grants are ever regenerated).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_settings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.memory_extraction_jobs TO service_role;

COMMIT;
