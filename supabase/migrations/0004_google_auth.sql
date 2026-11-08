-- ============================================================
-- Migration: 0004_google_auth.sql
-- Description: Google authentication & multi-user security (Milestone 3).
--
--   ADDITIVE migration. Creates:
--     1. Profile columns on `public.users` (display_name, avatar_url,
--        provider, updated_at) so Google and email/password accounts are
--        both recognized and rendered correctly.
--     2. An improved `handle_new_user()` signup trigger that copies the
--        provider / display name / avatar from Supabase auth metadata
--        (works identically for Google OAuth and email signups).
--     3. `handle_auth_user_updated()` — syncs profile changes that happen
--        AFTER signup (e.g. linking a Google identity to an existing
--        email account) so account recognition stays correct.
--     4. `users_insert_own` RLS policy so the API can self-heal a missing
--        profile row for the VERIFIED user only.
--     5. `public.integration_grants` — an audit record of EXPLICIT user
--        consent for ADDITIONAL Google scopes (Gmail, Calendar, …).
--        SECURITY INVARIANT: Google LOGIN never reads or writes this
--        table, and login never requests those scopes
--        (GOOGLE_LOGIN_SCOPES = 'openid email profile', shared/auth.ts).
--        Recording a grant does not call any Google API.
--
--   Apply with:  supabase db push   (or paste into the SQL editor)
-- ============================================================

-- ------------------------------------------------------------
-- 1. Profile columns for account recognition
-- ------------------------------------------------------------

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS avatar_url   text,
  ADD COLUMN IF NOT EXISTS provider     text NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();

-- Only the providers this application knows how to recognize.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_provider_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_provider_check CHECK (provider IN ('email', 'google'));
  END IF;
END $$;

COMMENT ON COLUMN public.users.provider IS
  'Auth provider that created the account (email | google). Synced from auth metadata; never client-writable.';
COMMENT ON COLUMN public.users.display_name IS
  'User-chosen display name (PATCH /api/me). Falls back to provider name when unset.';

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 2. Signup trigger: create a recognized profile for BOTH
--    Google OAuth and email/password signups.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, provider, display_name, avatar_url)
  VALUES (
    new.id,
    COALESCE(new.email, new.raw_user_meta_data ->> 'email'),
    COALESCE(new.raw_app_meta_data ->> 'provider', 'email'),
    COALESCE(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  ON CONFLICT (id) DO UPDATE SET
    email        = COALESCE(EXCLUDED.email, public.users.email),
    provider     = EXCLUDED.provider,
    display_name = COALESCE(EXCLUDED.display_name, public.users.display_name),
    avatar_url   = COALESCE(EXCLUDED.avatar_url, public.users.avatar_url),
    updated_at   = now();
  RETURN new;
END;
$$;

-- (Trigger `on_auth_user_created` from 0001 already points at this
-- function name — replacing the body updates it everywhere.)

-- ------------------------------------------------------------
-- 3. Account-linking / post-signup sync.
--    When an auth user changes (e.g. a Google identity is linked to an
--    existing email account, metadata is refreshed, or the email is
--    updated), keep the application profile in step — keyed by id, so
--    ownership of every task/reminder/conversation is untouched.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_auth_user_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  BEGIN
    UPDATE public.users SET
      email        = COALESCE(new.email, public.users.email),
      provider     = COALESCE(new.raw_app_meta_data ->> 'provider', public.users.provider),
      display_name = COALESCE(
                        new.raw_user_meta_data ->> 'full_name',
                        new.raw_user_meta_data ->> 'name',
                        public.users.display_name
                      ),
      avatar_url   = COALESCE(new.raw_user_meta_data ->> 'avatar_url', public.users.avatar_url),
      updated_at   = now()
    WHERE id = new.id;
  EXCEPTION WHEN unique_violation THEN
    -- Email collision with a DIFFERENT profile row (defensive: GoTrue
    -- keeps emails unique per instance). Sync everything except email
    -- rather than breaking the auth operation that triggered us.
    UPDATE public.users SET
      provider     = COALESCE(new.raw_app_meta_data ->> 'provider', public.users.provider),
      display_name = COALESCE(
                        new.raw_user_meta_data ->> 'full_name',
                        new.raw_user_meta_data ->> 'name',
                        public.users.display_name
                      ),
      avatar_url   = COALESCE(new.raw_user_meta_data ->> 'avatar_url', public.users.avatar_url),
      updated_at   = now()
    WHERE id = new.id;
  END;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_updated();

-- ------------------------------------------------------------
-- 4. Self-heal: the API may insert its OWN missing profile row
--    (id = verified user id) — never anyone else's.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS users_insert_own ON public.users;
CREATE POLICY users_insert_own ON public.users
  FOR INSERT WITH CHECK (auth.uid() = id);

-- ------------------------------------------------------------
-- 5. Integration grants — EXPLICIT consent for ADDITIONAL scopes.
--
--    Invariant (enforced here AND in shared/auth.ts validation):
--    only the allow-listed extra scopes can be stored, login scopes
--    are not grantable (they are implicit in the session), and each
--    user may hold at most ONE row per integration.
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.integration_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  integration text NOT NULL CHECK (integration IN ('google')),
  -- Extra (non-login) scopes the user explicitly authorized.
  scopes      text[] NOT NULL DEFAULT '{}'
              CHECK (scopes <@ ARRAY['gmail.readonly', 'calendar.readonly']::text[]),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, integration)
);

COMMENT ON TABLE public.integration_grants IS
  'Audit record of explicit user consent for ADDITIONAL Google scopes beyond login (openid email profile). Google login never reads this table; no Gmail/Calendar API is called yet. Revocation clears scopes and sets revoked_at.';

DROP TRIGGER IF EXISTS integration_grants_set_updated_at ON public.integration_grants;
CREATE TRIGGER integration_grants_set_updated_at
  BEFORE UPDATE ON public.integration_grants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.integration_grants ENABLE ROW LEVEL SECURITY;

-- Explicit grants so both the API (authenticated, constrained by RLS) and
-- privileged service-role paths (worker/admin scripts, which bypass RLS)
-- can access the table regardless of harness default privileges.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.integration_grants
  TO authenticated, service_role;

DROP POLICY IF EXISTS integration_grants_select_own ON public.integration_grants;
CREATE POLICY integration_grants_select_own ON public.integration_grants
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS integration_grants_insert_own ON public.integration_grants;
CREATE POLICY integration_grants_insert_own ON public.integration_grants
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS integration_grants_update_own ON public.integration_grants;
CREATE POLICY integration_grants_update_own ON public.integration_grants
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS integration_grants_delete_own ON public.integration_grants;
CREATE POLICY integration_grants_delete_own ON public.integration_grants
  FOR DELETE USING (auth.uid() = user_id);

-- ============================================================
-- End of 0004_google_auth.sql
-- ============================================================
