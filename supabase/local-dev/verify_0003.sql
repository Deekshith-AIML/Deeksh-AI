-- ============================================================
-- Milestone 2 migration verification (runs against the local dev DB
-- AFTER 0000_auth_stub + 0001 + 0002 + 0003).
-- Exercises: seeding, claim semantics, retry bookkeeping, stale
-- recovery, idempotency index, cancellation, and RLS ownership.
-- ============================================================

\set ON_ERROR_STOP on

-- ---------- Seed -------------------------------------------------------
INSERT INTO auth.users (id, email)
VALUES ('11111111-1111-4111-8111-111111111111', 'alice@example.com'),
       ('22222222-2222-4222-8222-222222222222', 'bob@example.com')
ON CONFLICT (id) DO NOTHING;
-- ^ fires the on_auth_user_created trigger -> public.users rows exist.

INSERT INTO public.tasks (id, user_id, title, due_date)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001',
        '11111111-1111-4111-8111-111111111111',
        'Interview prep', now() + interval '1 day')
ON CONFLICT (id) DO NOTHING;

-- 3 due reminders for Alice (2 attached to the task, 1 standalone),
-- 1 future reminder (must NOT be claimable), 1 for Bob.
INSERT INTO public.reminders
  (id, user_id, task_id, title, reminder_at, next_attempt_at, idempotency_key)
VALUES
  ('bbbbbbbb-0000-4000-8000-000000000001',
   '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-000000000001',
   'Interview starts soon', now() - interval '1 minute', now(), 'k1'),
  ('bbbbbbbb-0000-4000-8000-000000000002',
   '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-0000-4000-8000-000000000001',
   'Prepare documents', now() - interval '30 seconds', now(), 'k2'),
  ('bbbbbbbb-0000-4000-8000-000000000003',
   '11111111-1111-4111-8111-111111111111',
   NULL,
   'Buy groceries reminder', now() - interval '10 seconds', now(), 'k3'),
  ('bbbbbbbb-0000-4000-8000-000000000004',
   '11111111-1111-4111-8111-111111111111',
   NULL,
   'Future reminder', now() + interval '2 hours', now() + interval '2 hours', 'k4'),
  ('bbbbbbbb-0000-4000-8000-000000000005',
   '22222222-2222-4222-8222-222222222222',
   NULL,
   'Bob due reminder', now(), now(), 'k5')
ON CONFLICT (id) DO NOTHING;

-- ---------- 1. Claim semantics ----------------------------------------
\echo '== claim #1 (expect 4 rows: 3 Alice due + 1 Bob due, NOT the future one) =='
SELECT r->>'id' AS id,
       r->>'title' AS title,
       r->>'status' AS status,
       (r->>'attempts')::int AS attempts,
       r->>'recipient_email' AS recipient_email
FROM public.claim_due_reminders(10) AS r
ORDER BY 1;

\echo '== claim #2 immediately after (expect 0 rows — already claimed) =='
SELECT count(*) AS second_claim_rows FROM public.claim_due_reminders(10);

\echo '== claimed rows carry attempts=1 and claimed_at set =='
SELECT count(*) AS claimed_with_attempt
FROM public.reminders
WHERE status = 'claimed' AND attempts = 1 AND claimed_at IS NOT NULL;

-- ---------- 2. Simulated delivery success/failure ----------------------
UPDATE public.reminders
SET status = 'sent', sent_at = now(), claimed_at = NULL
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- Transient failure path: back to pending with backoff in the future.
UPDATE public.reminders
SET status = 'pending', claimed_at = NULL, next_attempt_at = now() + interval '1 minute',
    failure_reason = 'simulated transient error'
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';

\echo '== backoff row is NOT claimable before next_attempt_at (expect 0 rows) =='
SELECT count(*) AS claimable_after_backoff FROM public.claim_due_reminders(10);

-- ---------- 3. Stale-claim recovery -----------------------------------
-- Make Alice's remaining claimed reminder look orphaned (old claim).
UPDATE public.reminders
SET claimed_at = now() - interval '10 minutes'
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003' AND status = 'claimed';

\echo '== recover_stale (expect 1) =='
SELECT public.recover_stale_reminders(300) AS recovered;

\echo '== recovered row is pending again with a fresh next_attempt_at =='
SELECT status, claimed_at IS NULL AS claim_cleared
FROM public.reminders WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003';

-- Exhausted attempts -> recovery marks FAILED instead of pending.
UPDATE public.reminders
SET status = 'claimed', claimed_at = now() - interval '10 minutes', attempts = max_attempts
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003';

\echo '== recover exhausted claim (expect 1) =='
SELECT public.recover_stale_reminders(300) AS recovered_exhausted;

\echo '== exhausted row is failed, not pending =='
SELECT status FROM public.reminders WHERE id = 'bbbbbbbb-0000-4000-8000-000000000003';

-- ---------- 4. Idempotency unique index --------------------------------
\echo '== duplicate idempotency key must violate the unique index =='
DO $$
BEGIN
  BEGIN
    INSERT INTO public.reminders (user_id, title, reminder_at, next_attempt_at, idempotency_key)
    VALUES ('11111111-1111-4111-8111-111111111111', 'dup attempt',
            now(), now(), 'k1');
    RAISE EXCEPTION 'FAIL: duplicate idempotency key was accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: duplicate idempotency key rejected (23505)';
  END;
END $$;

-- Same key for a DIFFERENT user must be allowed (uniqueness is per user).
-- (Clear any residue from a previous verification run so this stays
-- re-runnable; the check itself is unchanged.)
DELETE FROM public.reminders
WHERE user_id = '22222222-2222-4222-8222-222222222222' AND idempotency_key = 'k1';
INSERT INTO public.reminders (user_id, title, reminder_at, next_attempt_at, idempotency_key)
VALUES ('22222222-2222-4222-8222-222222222222', 'bob same key',
        now(), now(), 'k1');
\echo 'OK: same key allowed for a different user'

-- ---------- 5. Constraint checks --------------------------------------
\echo '== past reminder_at rejected by CHECK? (expect: allowed — validation is app-level, see note) =='
\echo '== max_attempts >= 1 enforced =='
DO $$
BEGIN
  BEGIN
    INSERT INTO public.reminders (user_id, title, reminder_at, next_attempt_at, max_attempts)
    VALUES ('11111111-1111-4111-8111-111111111111', 'bad', now(), now(), 0);
    RAISE EXCEPTION 'FAIL: max_attempts=0 was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: max_attempts=0 rejected';
  END;
END $$;

\echo '== claim p_limit bounds enforced =='
DO $$
BEGIN
  BEGIN
    PERFORM public.claim_due_reminders(0);
    RAISE EXCEPTION 'FAIL: p_limit=0 accepted';
  EXCEPTION WHEN raise_exception THEN
    RAISE NOTICE 'OK: p_limit=0 rejected';
  END;
END $$;

-- ---------- 6. RLS ownership enforcement -------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;

-- Alice's JWT view.
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SET request.jwt.claim.role = 'authenticated';
SET ROLE authenticated;

\echo '== Alice sees only her reminders =='
SELECT count(*) AS alice_sees FROM public.reminders;

\echo '== Alice cannot update Bob''s reminder (expect 0) =='
UPDATE public.reminders SET title = 'pwned'
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000005';
SELECT count(*) AS alice_modified_bob FROM public.reminders
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000005' AND title = 'pwned';

\echo '== authenticated role CANNOT execute claim function (expect denied) =='
DO $$
BEGIN
  BEGIN
    PERFORM public.claim_due_reminders(1);
    RAISE EXCEPTION 'FAIL: authenticated executed claim_due_reminders';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'OK: claim function denied to authenticated';
  END;
END $$;

RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.jwt.claim.role;

-- service_role can execute it (worker path).
SET ROLE service_role;
\echo '== service_role CAN execute claim (worker path) =='
SELECT count(*) AS service_claim_rows FROM public.claim_due_reminders(10);
RESET ROLE;

\echo '== ALL MIGRATION CHECKS COMPLETED =='
