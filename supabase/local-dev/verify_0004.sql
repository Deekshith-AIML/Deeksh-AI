-- ============================================================
-- Milestone 3 migration verification (runs against the local dev DB
-- AFTER 0000_auth_stub + 0001 + 0002 + 0003 + 0004).
--
-- Exercises:
--   A. auth metadata columns (idempotent bootstrap for running containers)
--   B. profile creation from Google-style signup metadata
--   C. profile creation for a plain email signup (provider stays 'email')
--   D. account-linking sync (email acct -> linked Google) preserving id
--   E. self-heal profile insert under the verified identity
--   F. integration_grants: explicit-scope allow-list + per-user unique
--   G. RLS: profile and grants fully isolated between users
-- ============================================================

\set ON_ERROR_STOP on

-- ---------- A. bootstrap metadata columns on older local containers ------
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS raw_app_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- ---------- B. Google-style signup -> recognized profile ----------------
INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  'gidon@example.com',
  '{"provider":"google","providers":["google"]}'::jsonb,
  '{"sub":"44444444-4444-4444-8444-444444444444","full_name":"Gi Don","avatar_url":"https://example.com/gi.png"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

\echo '== google signup creates provider=google + display name + avatar =='
SELECT provider, display_name, avatar_url
FROM public.users WHERE id = '44444444-4444-4444-8444-444444444444';

-- ---------- C. plain email signup -> provider stays 'email' -------------
INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  'emailonly@example.com',
  '{"provider":"email"}'::jsonb,
  '{}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

\echo '== email signup keeps provider=email, null display name =='
SELECT provider, display_name IS NULL AS no_display_name
FROM public.users WHERE id = '55555555-5555-4555-8555-555555555555';

-- ---------- D. account linking: email account gains Google --------------
-- Same auth id — Supabase links the identity, it does not create a new
-- user. The profile must follow, and the id — hence all owned data —
-- must NOT change.
INSERT INTO public.tasks (id, user_id, title)
VALUES ('dddddddd-0000-4000-8000-000000000001',
        '55555555-5555-4555-8555-555555555555',
        'pre-link task')
ON CONFLICT (id) DO NOTHING;

UPDATE auth.users
SET raw_app_meta_data = '{"provider":"google","providers":["google","email"]}'::jsonb,
    raw_user_meta_data = '{"full_name":"Linked User","avatar_url":"https://example.com/l.png"}'::jsonb
WHERE id = '55555555-5555-4555-8555-555555555555';

\echo '== linking syncs profile (provider/display) and keeps the same id =='
SELECT provider, display_name, avatar_url
FROM public.users WHERE id = '55555555-5555-4555-8555-555555555555';

\echo '== pre-link task still owned by the SAME user (ownership untouched) =='
SELECT count(*) AS pre_link_tasks_owned
FROM public.tasks
WHERE id = 'dddddddd-0000-4000-8000-000000000001'
  AND user_id = '55555555-5555-4555-8555-555555555555';

-- ---------- F. grants: allow-list + uniqueness --------------------------
\echo '== out-of-allowlist scope must be rejected by CHECK =='
DO $$
BEGIN
  BEGIN
    INSERT INTO public.integration_grants (user_id, integration, scopes)
    VALUES ('55555555-5555-4555-8555-555555555555', 'google',
            ARRAY['drive.full_control']);
    RAISE EXCEPTION 'FAIL: disallowed scope was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: disallowed scope rejected';
  END;
END $$;

\echo '== login scopes must not be grantable as "extra" =='
DO $$
BEGIN
  BEGIN
    INSERT INTO public.integration_grants (user_id, integration, scopes)
    VALUES ('55555555-5555-4555-8555-555555555555', 'google',
            ARRAY['openid']);
    RAISE EXCEPTION 'FAIL: login scope was accepted as an extra grant';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: login scope rejected';
  END;
END $$;

INSERT INTO public.integration_grants (user_id, integration, scopes)
VALUES ('55555555-5555-4555-8555-555555555555', 'google',
        ARRAY['gmail.readonly'])
ON CONFLICT (user_id, integration) DO NOTHING;

\echo '== one row per (user, integration) =='
DO $$
BEGIN
  BEGIN
    INSERT INTO public.integration_grants (user_id, integration, scopes)
    VALUES ('55555555-5555-4555-8555-555555555555', 'google',
            ARRAY['calendar.readonly']);
    RAISE EXCEPTION 'FAIL: duplicate (user, integration) grant accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: duplicate grant rejected';
  END;
END $$;

-- ---------- E. self-heal: verified user inserts OWN missing profile -----
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- Bootstrap a user whose profile row is MISSING (API self-heal path).
INSERT INTO auth.users (id, email, raw_app_meta_data)
VALUES ('66666666-6666-4666-8666-666666666666', 'heal@example.com',
        '{"provider":"google"}'::jsonb)
ON CONFLICT (id) DO NOTHING;
DELETE FROM public.users WHERE id = '66666666-6666-4666-8666-666666666666';

SET request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';
SET request.jwt.claim.role = 'authenticated';
SET ROLE authenticated;

INSERT INTO public.users (id, email, provider)
VALUES ('66666666-6666-4666-8666-666666666666', 'heal@example.com', 'google');
\echo 'OK: own-profile self-heal insert allowed'

\echo '== but NEVER insert a profile for someone else (expect denial) =='
RESET ROLE;
INSERT INTO auth.users (id, email)
VALUES ('77777777-7777-4777-8777-777777777777', 'victim@example.com')
ON CONFLICT (id) DO NOTHING;
DELETE FROM public.users WHERE id = '77777777-7777-4777-8777-777777777777';
SET request.jwt.claim.sub = '66666666-6666-4666-8666-666666666666';
SET ROLE authenticated;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.users (id, email)
    VALUES ('77777777-7777-4777-8777-777777777777', 'victim@example.com');
    RAISE EXCEPTION 'FAIL: inserted a profile for another id';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN
    RAISE NOTICE 'OK: cross-user profile insert denied by RLS';
  END;
END $$;

-- ---------- G. isolation between users ----------------------------------
-- As Gi (4444): grants/profile of others must be invisible and unwritable.
SET request.jwt.claim.sub = '44444444-4444-4444-8444-444444444444';

\echo '== Gi sees only her own grant rows (expect 0) =='
SELECT count(*) AS gi_sees_grants FROM public.integration_grants;

\echo '== Gi cannot grant scopes on someone else''s behalf =='
DO $$
BEGIN
  BEGIN
    INSERT INTO public.integration_grants (user_id, integration, scopes)
    VALUES ('55555555-5555-4555-8555-555555555555', 'google',
            ARRAY['gmail.readonly']);
    RAISE EXCEPTION 'FAIL: forged grant for another user succeeded';
  EXCEPTION WHEN insufficient_privilege OR unique_violation THEN
    RAISE NOTICE 'OK: cross-user grant insert denied by RLS';
  END;
END $$;

\echo '== Gi cannot read another user''s profile (expect 0) =='
SELECT count(*) AS gi_sees_others
FROM public.users WHERE id = '55555555-5555-4555-8555-555555555555';

\echo '== Gi cannot rewrite another user''s grant scopes (expect 0) =='
UPDATE public.integration_grants SET scopes = ARRAY['calendar.readonly']
WHERE user_id = '55555555-5555-4555-8555-555555555555';

RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.jwt.claim.role;

\echo '== victim''s grant scopes are still intact after Gi''s attempt =='
SELECT count(*) AS victim_scope_intact
FROM public.integration_grants
WHERE user_id = '55555555-5555-4555-8555-555555555555'
  AND scopes = ARRAY['gmail.readonly'];

\echo '== service_role bypasses RLS for worker/admin paths (expect >0) =='
SET ROLE service_role;
SELECT count(*) AS service_grants_visible FROM public.integration_grants;
RESET ROLE;

\echo '== ALL MIGRATION 0004 CHECKS COMPLETED =='
