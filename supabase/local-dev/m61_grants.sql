-- ============================================================
-- Phase 6.1 environment setup: Supabase-equivalent default privileges.
-- On real Supabase, the platform runs ALTER DEFAULT PRIVILEGES so every
-- table in public is usable by anon/authenticated/service_role (RLS
-- then restricts rows). Plain Postgres has no such defaults, so this
-- script mirrors them. Environment setup only — migrations unchanged.
-- ============================================================
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;

-- worker functions stay service_role-only (already granted in 0003/0005/0013);
-- ensure authenticated cannot execute them.
REVOKE EXECUTE ON FUNCTION public.claim_due_reminders(integer) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.recover_stale_reminders(integer) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.claim_memory_extraction_jobs(int) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.recover_stale_extraction_jobs(int) FROM PUBLIC, authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.recover_stale_agent_runs(int) FROM PUBLIC, authenticated, anon;
