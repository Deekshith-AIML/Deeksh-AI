-- ============================================================
-- Migration: 0002_auth_hardening.sql
-- Description: Authentication hardening for the Task Assistant.
--
--   0001_init.sql already creates the tables, the auth->profile trigger,
--   and per-owner RLS policies. This migration is ADDITIVE:
--
--   1. Backfills public.users from auth.users (idempotent) so every
--      profile row is tied to a real Supabase Auth identity.
--   2. Adds a foreign key public.users.id -> auth.users.id (with
--      ON DELETE CASCADE) **only if** no orphan profiles exist, so the
--      migration never fails and never silently destroys data.
--   3. Documents the trust model in table/column comments.
--
--   Apply with:  supabase db push   (or paste into the SQL editor)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Backfill: every auth user must have a public.users row.
--    The on_auth_user_created trigger handles NEW signups; this catches
--    any profile rows that were deleted, or auth users created before
--    the trigger existed. Idempotent via ON CONFLICT.
-- ------------------------------------------------------------

INSERT INTO public.users (id, email)
SELECT u.id, COALESCE(u.email, '')
FROM auth.users u
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

-- ------------------------------------------------------------
-- 2. Orphan report (informational — no destructive action taken).
--    Orphan profile rows are public.users rows with no matching
--    auth.users row (e.g. the old hard-coded demo identity).
--    They are LEFT IN PLACE by this migration on purpose.
-- ------------------------------------------------------------

DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM public.users p
  WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = p.id);

  IF orphan_count > 0 THEN
    RAISE NOTICE '0002: % orphan public.users row(s) have no auth.users identity; FK not added yet.', orphan_count;
    RAISE NOTICE '0002: Review and remove them manually if desired (see report), then re-run the FK step.';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Foreign key: profile id must equal an auth identity id.
--    Added only when zero orphans exist (safe/idempotent).
--    ON DELETE CASCADE: deleting an auth user removes the profile,
--    which cascades to tasks and messages (already configured in 0001).
-- ------------------------------------------------------------

DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM public.users p
  WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = p.id);

  IF orphan_count = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'users_id_auth_fkey'
        AND conrelid = 'public.users'::regclass
    ) THEN
      ALTER TABLE public.users
        ADD CONSTRAINT users_id_auth_fkey
        FOREIGN KEY (id) REFERENCES auth.users(id)
        ON DELETE CASCADE;
      RAISE NOTICE '0002: added FK public.users.id -> auth.users.id.';
    END IF;
  ELSE
    RAISE NOTICE '0002: FK step skipped because orphans exist (see above).';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Trust-model documentation (for future maintainers).
-- ------------------------------------------------------------

COMMENT ON COLUMN public.tasks.user_id IS
  'Owner = auth.users.id. Enforced by RLS (auth.uid() = user_id) AND by explicit user_id filters in the API server service layer.';
COMMENT ON COLUMN public.messages.user_id IS
  'Owner = auth.users.id. History for one user is never readable by another: RLS + server-side scoping.';
COMMENT ON TABLE public.users IS
  'Application profile per Supabase Auth user; id references auth.users.id (when 0002 FK step has run).';

-- ------------------------------------------------------------
-- 5. RLS review (no changes required).
--    0001_init.sql policies already enforce:
--      users:    SELECT/UPDATE own row only
--      tasks:    SELECT/INSERT/UPDATE/DELETE own rows only
--      messages: SELECT/INSERT own rows only (no UPDATE/DELETE policy
--                => chat history is immutable to API clients, which is
--                the intended least-privilege posture).
--    RLS remains ENABLED on all three tables. Do not disable it.
--    NOTE: direct PostgREST access from browsers would rely on these
--    policies; the API server additionally sends the user's JWT so the
--    policies apply to every server-side query as well.
-- ============================================================
