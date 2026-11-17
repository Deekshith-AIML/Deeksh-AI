-- ============================================================
-- Phase 6.1 §2 — behavioral verification against the LIVE local DB.
-- Run as postgres (superuser) but uses SET ROLE to exercise the
-- actual anon/authenticated/service_role permissions and RLS.
-- Every check prints a PASS/FAIL row; no secret values involved.
-- ============================================================
\set ON_ERROR_STOP 0
\pset pager off

-- ---------- seed two users (idempotent) ----------
-- 0002 adds users_id_auth_fkey: public.users.id must exist in auth.users.
-- Insert into auth.users; the on_auth_user_created trigger (0001) then
-- creates the public.users row. raw_user_meta_data is NOT NULL in GoTrue's
-- schema, so supply it explicitly.
INSERT INTO auth.users (id, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-00000000000a', 'user-a@m61.test', '{}'::jsonb, '{}'::jsonb, now(), now()),
       ('00000000-0000-4000-8000-00000000000b', 'user-b@m61.test', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email)
VALUES ('00000000-0000-4000-8000-00000000000a', 'user-a@m61.test'),
       ('00000000-0000-4000-8000-00000000000b', 'user-b@m61.test')
ON CONFLICT (id) DO NOTHING;

-- ---------- cleanup from prior runs (postgres superuser; the
-- append-only restriction applies to authenticated, not superuser) ----------
DELETE FROM public.agent_audit_events
 WHERE run_id IN ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002')
    OR (event='section2_fixture_event' AND user_id='00000000-0000-4000-8000-00000000000a');
DELETE FROM public.agent_approvals
 WHERE run_id IN ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
DELETE FROM public.agent_run_steps
 WHERE run_id IN ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');
DELETE FROM public.agent_runs
 WHERE id IN ('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002');

-- user B's fixture graph (must EXIST so the cross-user test proves RLS
-- visibility, not merely a missing FK target)
INSERT INTO public.agent_runs (id, user_id, objective, status)
VALUES ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-00000000000b',
        'section2 fixture run B', 'waiting_approval')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.agent_run_steps (id, run_id, user_id, step_key, agent_name, operation, status, requires_approval)
VALUES ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-00000000000b', 'delete_the_task_b', 'task', 'delete',
        'waiting_approval', true)
ON CONFLICT (id) DO NOTHING;

-- helper: run an expression, print PASS/FAIL
CREATE OR REPLACE FUNCTION pg_temp.chk(label text, ok boolean, detail text DEFAULT '')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE '%: % %', CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, label, detail;
END $$;

-- ============================================================
-- 2.1 approval status CHECK (8 statuses)
-- ============================================================
DO $$
DECLARE bad text;
BEGIN
  -- valid statuses insert fine (use a throwaway run/step first? no:
  -- CHECK is evaluated before FK/trigger? order: constraints checked
  -- after BEFORE triggers. Use a real owned graph to isolate CHECK.)
  RAISE NOTICE '--- 2.1 status CHECK ---';
END $$;

-- Build a valid owned graph as fixture (user A).
INSERT INTO public.agent_runs (id, user_id, objective, status)
VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a',
        'section2 fixture run', 'waiting_approval')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.agent_run_steps (id, run_id, user_id, step_key, agent_name, operation, status, requires_approval)
VALUES ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-00000000000a', 'delete_the_task', 'task', 'delete',
        'waiting_approval', true)
ON CONFLICT (id) DO NOTHING;

-- 2.1a invalid approval status must be rejected
DO $$
BEGIN
  BEGIN
    INSERT INTO public.agent_approvals (run_id, step_id, user_id, action_description, payload_hash, status, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-00000000000a','bad status', repeat('a',64), 'bogus_status', now() + interval '1 hour');
    RAISE NOTICE 'FAIL: invalid approval status accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: invalid approval status rejected (%)', SQLERRM;
  END;
  -- invalid run status
  BEGIN
    INSERT INTO public.agent_runs (user_id, objective, status)
    VALUES ('00000000-0000-4000-8000-00000000000a','bad run status','teleporting');
    RAISE NOTICE 'FAIL: invalid run status accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: invalid run status rejected';
  END;
  -- invalid step status
  BEGIN
    INSERT INTO public.agent_run_steps (run_id, user_id, step_key, agent_name, operation, status)
    VALUES ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000000a','s1','task','list','bogus');
    RAISE NOTICE 'FAIL: invalid step status accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: invalid step status rejected';
  END;
END $$;

-- ============================================================
-- 2.2 payload_hash CHECK (sha256 hex)
-- ============================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO public.agent_approvals (run_id, step_id, user_id, action_description, payload_hash, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-00000000000a','bad hash','NOT-A-HASH', now() + interval '1 hour');
    RAISE NOTICE 'FAIL: malformed payload_hash accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: malformed payload_hash rejected (%)', SQLERRM;
  END;
  BEGIN
    INSERT INTO public.agent_approvals (run_id, step_id, user_id, action_description, payload_hash, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-00000000000a','uppercase hash', upper(repeat('a',64)), now() + interval '1 hour');
    RAISE NOTICE 'FAIL: uppercase payload_hash accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: uppercase payload_hash rejected';
  END;
END $$;

-- ============================================================
-- 2.3 partial unique index: only ONE pending approval per step
-- ============================================================
DO $$
BEGIN
  INSERT INTO public.agent_approvals (id, run_id, step_id, user_id, action_description, payload_hash, status, expires_at)
  VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000000a',
          'first pending', repeat('b',64), 'pending', now() + interval '1 hour');
  BEGIN
    INSERT INTO public.agent_approvals (run_id, step_id, user_id, action_description, payload_hash, status, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-00000000000a','second pending', repeat('c',64), 'pending', now() + interval '1 hour');
    RAISE NOTICE 'FAIL: second pending approval for same step accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: second pending approval for same step rejected (%)', SQLERRM;
  END;
  -- a NON-pending approval for the same step must be allowed
  BEGIN
    INSERT INTO public.agent_approvals (run_id, step_id, user_id, action_description, payload_hash, status, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-00000000000a','historical rejected', repeat('d',64), 'rejected', now() + interval '1 hour');
    RAISE NOTICE 'PASS: non-pending approval for same step allowed (partial index scoped to pending)';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'FAIL: non-pending approval blocked by pending index';
  END;
END $$;

-- ============================================================
-- 2.4 FKs + ownership triggers
-- ============================================================
DO $$
BEGIN
  -- approval whose step belongs to a DIFFERENT run
  BEGIN
    INSERT INTO public.agent_approvals (run_id, step_id, user_id, action_description, payload_hash, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000009', -- nonexistent step
            '00000000-0000-4000-8000-00000000000a','ghost step', repeat('e',64), now() + interval '1 hour');
    RAISE NOTICE 'FAIL: approval with nonexistent step accepted';
  EXCEPTION WHEN raise_exception OR foreign_key_violation THEN
    RAISE NOTICE 'PASS: approval with nonexistent step rejected (%)', SQLERRM;
  END;
  -- step user mismatch with run (owner trigger)
  BEGIN
    INSERT INTO public.agent_run_steps (run_id, user_id, step_key, agent_name, operation)
    VALUES ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-00000000000b','x1','task','list');
    RAISE NOTICE 'FAIL: step owner mismatch accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS: step owner mismatch rejected (%)', SQLERRM;
  END;
  -- approval user mismatch with run owner
  BEGIN
    INSERT INTO public.agent_approvals (run_id, step_id, user_id, action_description, payload_hash, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-00000000000b','cross owner', repeat('f',64), now() + interval '1 hour');
    RAISE NOTICE 'FAIL: approval owner mismatch accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'PASS: approval owner mismatch rejected (%)', SQLERRM;
  END;
  -- run with nonexistent user (FK)
  BEGIN
    INSERT INTO public.agent_runs (user_id, objective)
    VALUES ('99999999-9999-4999-8999-999999999999','ghost user run');
    RAISE NOTICE 'FAIL: run with nonexistent user accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS: run FK to users enforced';
  END;
END $$;

-- ============================================================
-- 2.5 executed_at semantics + status transitions in DB
-- ============================================================
DO $$
DECLARE st text; ex timestamptz;
BEGIN
  UPDATE public.agent_approvals
     SET status='approved', decided_at=now()
   WHERE id='30000000-0000-4000-8000-000000000001';
  -- executed_at must be NULL until executed
  SELECT status, executed_at INTO st, ex FROM public.agent_approvals WHERE id='30000000-0000-4000-8000-000000000001';
  IF st='approved' AND ex IS NULL THEN
    RAISE NOTICE 'PASS: approved state has executed_at NULL';
  ELSE
    RAISE NOTICE 'FAIL: approved state status=% executed_at=%', st, ex;
  END IF;
  UPDATE public.agent_approvals SET status='executed', executed_at=now() WHERE id='30000000-0000-4000-8000-000000000001';
  SELECT status, executed_at INTO st, ex FROM public.agent_approvals WHERE id='30000000-0000-4000-8000-000000000001';
  IF st='executed' AND ex IS NOT NULL THEN
    RAISE NOTICE 'PASS: executed state has executed_at set (%)', ex;
  ELSE
    RAISE NOTICE 'FAIL: executed state status=% executed_at=%', st, ex;
  END IF;
END $$;

-- ============================================================
-- 2.6 audit append-only (as postgres: table-level, then RLS below)
-- ============================================================
INSERT INTO public.agent_audit_events (user_id, run_id, event, outcome, metadata)
VALUES ('00000000-0000-4000-8000-00000000000a','10000000-0000-4000-8000-000000000001',
        'section2_fixture_event','ok','{"source":"section2"}'::jsonb);

-- ============================================================
-- 2.7 RLS enabled on EVERY table + policies present
-- ============================================================
DO $$
DECLARE r record; n int; pol text;
BEGIN
  RAISE NOTICE '--- 2.7 RLS flags ---';
  FOR r IN
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
     WHERE ns.nspname='public' AND c.relkind='r'
       AND c.relname IN ('agent_runs','agent_run_steps','agent_approvals','agent_audit_events',
                         'tasks','messages','reminders','memories','memory_settings',
                         'memory_extraction_jobs','documents','integration_grants','users')
  LOOP
    RAISE NOTICE 'RLS table=% enabled=% forced=%', r.relname, r.relrowsecurity, r.relforcerowsecurity;
  END LOOP;
  -- count policies per agent table
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public'
           AND tablename IN ('agent_runs','agent_run_steps','agent_approvals','agent_audit_events')
  LOOP
    SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename=r.tablename;
    RAISE NOTICE 'POLICIES table=% count=%', r.tablename, n;
  END LOOP;
END $$;

-- ============================================================
-- 2.8 RLS behavior as `authenticated` (user A JWT claims)
--     and as `service_role` (BYPASSRLS), plus anon.
-- ============================================================
SET ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated","email":"user-a@m61.test"}', false);
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-8000-00000000000a', false);
SELECT set_config('request.jwt.claim.role','authenticated', false);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_runs;
  RAISE NOTICE 'authenticated(A) sees agent_runs=% (expect >=1)', n;
  SELECT count(*) INTO n FROM public.agent_runs WHERE user_id <> '00000000-0000-4000-8000-00000000000a';
  RAISE NOTICE '%: authenticated(A) sees foreign agent_runs=% (expect 0)',
    CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END, n;
  SELECT count(*) INTO n FROM public.agent_approvals WHERE user_id <> '00000000-0000-4000-8000-00000000000a';
  RAISE NOTICE '%: authenticated(A) sees foreign approvals=% (expect 0)',
    CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END, n;
  SELECT count(*) INTO n FROM public.agent_audit_events WHERE user_id <> '00000000-0000-4000-8000-00000000000a';
  RAISE NOTICE '%: authenticated(A) sees foreign audit=% (expect 0)',
    CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END, n;
END $$;

-- user A inserting an approval FOR user B's run must be blocked (RLS: no row visible → FK/trigger fail)
DO $$
DECLARE ok boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.agent_approvals (run_id, step_id, user_id, action_description, payload_hash, expires_at)
    VALUES ('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-00000000000a','cross insert', repeat('1',64), now() + interval '1 hour');
    ok := true;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS: authenticated insert referencing foreign run/step blocked (%)', SQLERRM;
  END;
  IF ok THEN RAISE NOTICE 'FAIL: authenticated inserted approval for foreign run'; END IF;
END $$;

-- audit UPDATE/DELETE must be blocked by RLS (no UPDATE/DELETE policy)
DO $$
DECLARE nu int; nd int;
BEGIN
  UPDATE public.agent_audit_events SET event='tampered' WHERE user_id='00000000-0000-4000-8000-00000000000a';
  GET DIAGNOSTICS nu = ROW_COUNT;
  DELETE FROM public.agent_audit_events WHERE user_id='00000000-0000-4000-8000-00000000000a';
  GET DIAGNOSTICS nd = ROW_COUNT;
  RAISE NOTICE '%: authenticated audit UPDATE affected=% (expect 0)',
    CASE WHEN nu=0 THEN 'PASS' ELSE 'FAIL' END, nu;
  RAISE NOTICE '%: authenticated audit DELETE affected=% (expect 0)',
    CASE WHEN nd=0 THEN 'PASS' ELSE 'FAIL' END, nd;
END $$;

-- service_role: BYPASSRLS sees everything
RESET ROLE;
SET ROLE service_role;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_runs;
  RAISE NOTICE 'service_role sees agent_runs=% (expect >=2, bypasses RLS)', n;
  SELECT count(*) INTO n FROM public.agent_audit_events;
  RAISE NOTICE 'service_role sees audit events=% (expect >=1)', n;
END $$;

-- anon: sees nothing (clear the session JWT claims first — a real anon
-- PostgREST request carries no Authorization header, so no claims exist)
RESET ROLE;
SELECT set_config('request.jwt.claims','', false);
SELECT set_config('request.jwt.claim.sub','', false);
SELECT set_config('request.jwt.claim.role','', false);
SET ROLE anon;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.agent_runs;
  RAISE NOTICE '%: anon sees agent_runs=% (expect 0)', CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END, n;
  SELECT count(*) INTO n FROM public.agent_approvals;
  RAISE NOTICE '%: anon sees approvals=% (expect 0)', CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END, n;
  SELECT count(*) INTO n FROM public.tasks;
  RAISE NOTICE '%: anon sees tasks=% (expect 0)', CASE WHEN n=0 THEN 'PASS' ELSE 'FAIL' END, n;
END $$;

-- recover_stale_agent_runs must be service_role-only
RESET ROLE;
DO $$
DECLARE gr text;
BEGIN
  SELECT string_agg(grantee||':'||privilege_type, ', ') INTO gr
    FROM information_schema.routine_privileges
   WHERE routine_name='recover_stale_agent_runs' AND routine_schema='public';
  RAISE NOTICE 'recover_stale_agent_runs grants: %', gr;
END $$;

RESET ROLE;
\echo '=== section 2 SQL complete ==='
