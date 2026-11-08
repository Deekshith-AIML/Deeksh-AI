-- ============================================================
-- Milestone 4.2 live verification for migrations 0007 + 0008
-- (and the reminder/extraction claim functions from 0003/0005).
--
-- SAFE: everything runs inside one transaction that ends in ROLLBACK.
-- No production/user rows are modified or deleted.
--
-- Run:
--   docker exec chitti-pg psql -U postgres -d task_assistant \
--     -v ON_ERROR_STOP=1 -f /migrations/supabase/local-dev/verify_0007_0008.sql
-- ============================================================
\set ON_ERROR_STOP on

BEGIN;

CREATE TEMP TABLE verify_results (
  check_name text PRIMARY KEY,
  outcome    text NOT NULL,
  detail     text
) ON COMMIT DROP;

-- ------------------------------------------------------------
-- Fixtures: two isolated users
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'verify-a@example.com'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'verify-b@example.com');

INSERT INTO public.users (id, email) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'verify-a@example.com'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'verify-b@example.com')
ON CONFLICT (id) DO NOTHING;

-- Unit vectors: e1 = axis 1, e2 = axis 2.
CREATE TEMP TABLE unit_vectors AS
SELECT
  (SELECT array_agg(CASE WHEN i = 1 THEN 1.0::real ELSE 0.0::real END)
     FROM generate_series(1, 1536) AS i)::vector(1536) AS e1,
  (SELECT array_agg(CASE WHEN i = 2 THEN 1.0::real ELSE 0.0::real END)
     FROM generate_series(1, 1536) AS i)::vector(1536) AS e2;

INSERT INTO public.memories
  (user_id, content, category, embedding, status, confidence)
SELECT 'aaaaaaaa-0000-4000-8000-000000000001', 'verify A personal fact', 'personal_fact', e1, 'active', 'high'
FROM unit_vectors;

INSERT INTO public.memories
  (user_id, content, category, embedding, status, confidence)
SELECT 'aaaaaaaa-0000-4000-8000-000000000001', 'verify A career goal', 'career_goal', e2, 'active', 'high'
FROM unit_vectors;

INSERT INTO public.memories
  (user_id, content, category, embedding, status, confidence)
SELECT 'bbbbbbbb-0000-4000-8000-000000000002', 'verify B career goal', 'career_goal', e1, 'active', 'high'
FROM unit_vectors;

-- ------------------------------------------------------------
-- 1. Category filtering + user isolation through match_memories
-- ------------------------------------------------------------
DO $$
DECLARE
  all_rows int;
  career_rows int;
  foreign_rows int;
BEGIN
  SELECT count(*) INTO all_rows
    FROM match_memories((SELECT e1 FROM unit_vectors),
                        'aaaaaaaa-0000-4000-8000-000000000001', 0.0, 10, NULL);
  SELECT count(*) INTO career_rows
    FROM match_memories((SELECT e1 FROM unit_vectors),
                        'aaaaaaaa-0000-4000-8000-000000000001', 0.0, 10, 'career_goal');
  SELECT count(*) INTO foreign_rows
    FROM match_memories((SELECT e1 FROM unit_vectors),
                        'aaaaaaaa-0000-4000-8000-000000000001', 0.0, 10, NULL)
   WHERE user_id <> 'aaaaaaaa-0000-4000-8000-000000000001';

  INSERT INTO verify_results VALUES
    ('category_filter', CASE WHEN all_rows = 2 AND career_rows = 1 THEN 'PASS' ELSE 'FAIL' END,
     format('unfiltered=%s career_goal=%s (expected 2/1)', all_rows, career_rows)),
    ('match_memories_user_isolation', CASE WHEN foreign_rows = 0 THEN 'PASS' ELSE 'FAIL' END,
     format('foreign rows returned=%s (expected 0)', foreign_rows));
END $$;

-- ------------------------------------------------------------
-- 2. Duplicate rejection by the partial UNIQUE index
-- ------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO public.memories (user_id, content, category, embedding, status, confidence)
  SELECT 'aaaaaaaa-0000-4000-8000-000000000001', 'verify A personal fact', 'personal_fact', e1, 'active', 'high'
  FROM unit_vectors;
  INSERT INTO verify_results VALUES ('duplicate_rejection', 'FAIL', 'duplicate insert succeeded');
EXCEPTION WHEN unique_violation THEN
  INSERT INTO verify_results VALUES ('duplicate_rejection', 'PASS', '23505 raised');
END $$;

-- Superseded history is exempt from the unique index.
DO $$
BEGIN
  INSERT INTO public.memories (user_id, content, category, embedding, status, confidence)
  SELECT 'aaaaaaaa-0000-4000-8000-000000000001', 'verify A personal fact', 'personal_fact', e1, 'superseded', 'high'
  FROM unit_vectors;
  INSERT INTO verify_results VALUES ('history_exempt_from_unique', 'PASS', 'superseded duplicate allowed');
EXCEPTION WHEN others THEN
  INSERT INTO verify_results VALUES ('history_exempt_from_unique', 'FAIL', SQLERRM);
END $$;

-- ------------------------------------------------------------
-- 3. RLS: authenticated user sees only their own memories
-- ------------------------------------------------------------
DO $$
DECLARE
  visible int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO visible FROM public.memories;
  EXECUTE 'RESET ROLE';
  INSERT INTO verify_results VALUES
    ('rls_memories_select_own', CASE WHEN visible = 3 THEN 'PASS' ELSE 'FAIL' END,
     format('authenticated user A sees %s rows (expected 3: 2 active + 1 superseded own rows)', visible));
END $$;

-- ------------------------------------------------------------
-- 4. Extraction-job atomic claim (1 then 0) + stale recovery
-- ------------------------------------------------------------
INSERT INTO public.messages (id, user_id, role, content)
VALUES ('cccccccc-0000-4000-8000-000000000003',
        'aaaaaaaa-0000-4000-8000-000000000001', 'user', 'verify extraction source');

INSERT INTO public.memory_extraction_jobs (id, user_id, message_id, status)
VALUES ('dddddddd-0000-4000-8000-000000000004',
        'aaaaaaaa-0000-4000-8000-000000000001',
        'cccccccc-0000-4000-8000-000000000003', 'pending');

DO $$
DECLARE
  first_claim int;
  second_claim int;
  attempts_after int;
  recovered int;
BEGIN
  SELECT count(*) INTO first_claim FROM claim_memory_extraction_jobs(5);
  SELECT count(*) INTO second_claim FROM claim_memory_extraction_jobs(5);
  SELECT attempts INTO attempts_after FROM public.memory_extraction_jobs
   WHERE id = 'dddddddd-0000-4000-8000-000000000004';

  INSERT INTO verify_results VALUES
    ('extraction_atomic_claim', CASE WHEN first_claim = 1 AND second_claim = 0 THEN 'PASS' ELSE 'FAIL' END,
     format('first=%s second=%s attempts=%s', first_claim, second_claim, attempts_after));

  UPDATE public.memory_extraction_jobs
     SET claimed_at = now() - interval '10 minutes'
   WHERE id = 'dddddddd-0000-4000-8000-000000000004';

  SELECT recover_stale_extraction_jobs(300) INTO recovered;
  INSERT INTO verify_results VALUES
    ('extraction_stale_recovery', CASE WHEN recovered >= 1 THEN 'PASS' ELSE 'FAIL' END,
     format('recovered=%s', recovered));
END $$;

-- ------------------------------------------------------------
-- 5. Reminder lifecycle: claim, duplicate prevention, stale
--    recovery, cancellation, future scheduling.
-- ------------------------------------------------------------
INSERT INTO public.reminders (id, user_id, title, reminder_at, next_attempt_at, status)
VALUES ('eeeeeeee-0000-4000-8000-000000000005',
        'aaaaaaaa-0000-4000-8000-000000000001', 'verify reminder',
        now() - interval '1 minute', now() - interval '1 minute', 'pending');

DO $$
DECLARE
  first_claim int;
  second_claim int;
  recovered int;
  future_claim int;
BEGIN
  SELECT count(*) INTO first_claim FROM claim_due_reminders(5) AS claim WHERE claim->>'id' = 'eeeeeeee-0000-4000-8000-000000000005';
  SELECT count(*) INTO second_claim FROM claim_due_reminders(5) AS claim WHERE claim->>'id' = 'eeeeeeee-0000-4000-8000-000000000005';
  INSERT INTO verify_results VALUES
    ('reminder_atomic_claim', CASE WHEN first_claim = 1 AND second_claim = 0 THEN 'PASS' ELSE 'FAIL' END,
     format('fixture first=%s second=%s', first_claim, second_claim));

  UPDATE public.reminders
     SET claimed_at = now() - interval '10 minutes'
   WHERE id = 'eeeeeeee-0000-4000-8000-000000000005';

  SELECT recover_stale_reminders(300) INTO recovered;
  INSERT INTO verify_results VALUES
    ('reminder_stale_recovery',
     CASE WHEN (SELECT status FROM public.reminders
                 WHERE id = 'eeeeeeee-0000-4000-8000-000000000005') = 'pending'
          THEN 'PASS' ELSE 'FAIL' END,
     format('fixture returned to pending; total recovered this tick=%s', recovered));

  -- Reschedule into the future: must not be claimable.
  UPDATE public.reminders
     SET status = 'pending', claimed_at = NULL,
         reminder_at = now() + interval '1 day',
         next_attempt_at = now() + interval '1 day'
   WHERE id = 'eeeeeeee-0000-4000-8000-000000000005';
  SELECT count(*) INTO future_claim FROM claim_due_reminders(5) AS claim WHERE claim->>'id' = 'eeeeeeee-0000-4000-8000-000000000005';
  INSERT INTO verify_results VALUES
    ('reminder_future_not_claimable', CASE WHEN future_claim = 0 THEN 'PASS' ELSE 'FAIL' END,
     format('fixture claimed=%s (expected 0)', future_claim));

  -- Cancellation: cancelled rows are never claimed.
  UPDATE public.reminders
     SET status = 'cancelled', next_attempt_at = now() - interval '1 minute'
   WHERE id = 'eeeeeeee-0000-4000-8000-000000000005';
  SELECT count(*) INTO future_claim FROM claim_due_reminders(5) AS claim WHERE claim->>'id' = 'eeeeeeee-0000-4000-8000-000000000005';
  INSERT INTO verify_results VALUES
    ('reminder_cancelled_not_claimable', CASE WHEN future_claim = 0 THEN 'PASS' ELSE 'FAIL' END,
     format('fixture claimed=%s (expected 0)', future_claim));
END $$;

-- ------------------------------------------------------------
-- Report
-- ------------------------------------------------------------
SELECT check_name, outcome, detail FROM verify_results ORDER BY check_name;

-- Never persist anything from this verification run.
ROLLBACK;
