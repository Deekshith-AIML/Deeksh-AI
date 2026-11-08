-- ============================================================
-- Milestone 4 — live retrieval + RLS evaluation (real pgvector)
-- ============================================================
-- Run as postgres (superuser) AFTER applying 0005:
--   psql -U postgres -d task_assistant -v ON_ERROR_STOP=1 \
--        -f supabase/local-dev/eval_match_memories.sql
--
-- Uses SYNTHETIC vectors with controlled geometry so the expected
-- cosine similarities are known exactly (1.0 / 0.9 / 0.8 / 0.0).
-- This verifies the SQL function's REAL cosine math, thresholding,
-- ordering, ownership and status filtering. Semantic quality with
-- live embeddings (Gemini Embedding 2) is evaluated separately and
-- documented in MILESTONE_4_REPORT.md.
-- ============================================================

\set ON_ERROR_STOP on
\set QUIET on

-- Idempotent cleanup of any previous evaluation rows.
DELETE FROM public.memories WHERE content LIKE 'EVAL-%';
DELETE FROM auth.users WHERE email LIKE 'eval-%@example.com';  -- cascades to public.users

-- Eval users must exist in auth.users first (public.users.id FK).
INSERT INTO auth.users (id, email)
VALUES ('99999999-9999-4999-8999-999999999991', 'eval-u1@example.com'),
       ('99999999-9999-4999-8999-999999999992', 'eval-u2@example.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (id, email, provider, display_name)
VALUES ('99999999-9999-4999-8999-999999999991', 'eval-u1@example.com', 'email', 'Eval U1'),
       ('99999999-9999-4999-8999-999999999992', 'eval-u2@example.com', 'email', 'Eval U2')
ON CONFLICT (id) DO NOTHING;

-- Vector helper: 1536-dim vector with the first three components set.
CREATE OR REPLACE FUNCTION public.eval_vec(a float8, b float8, c float8)
RETURNS vector
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (SELECT array_agg(
                   CASE WHEN ord = 1 THEN a::real
                        WHEN ord = 2 THEN b::real
                        WHEN ord = 3 THEN c::real
                        ELSE 0::real END
                   ORDER BY ord)
          FROM generate_series(1, 1536) AS ord)::vector;
$$;

-- ------------------------------------------------------------
-- Seed memories with controlled cosine geometry vs query e1=(1,0,0):
--   M1  exact         sim 1.00  active
--   M2  contradiction sim 0.80  active   (must co-exist with M1)
--   M3  sensitive     sim 0.90  active
--   M4  deleted       sim 1.00  status='deleted'      → excluded
--   M5  superseded    sim 1.00  status='superseded'   → excluded
--   M6  expired       sim 1.00  expired_at in past    → excluded
--   M7  credential    sim 1.00  sensitivity='credential' → excluded
--   M8  other user    sim 1.00  owned by U2           → excluded for U1
--   M9  irrelevant    sim 0.00 vs e1 (weather)        → below threshold
-- ------------------------------------------------------------
INSERT INTO public.memories (id, user_id, content, category, embedding,
                             embedding_provider, embedding_model_version,
                             embedding_dimensions, status, sensitivity,
                             superseded_by, expired_at, source_evidence, confidence)
VALUES
 ('aaaaaaa1-0000-4000-8000-000000000001', '99999999-9999-4999-8999-999999999991',
  'EVAL-PY-PREF: I prefer Python for scripting.', 'user_preference', public.eval_vec(1, 0, 0),
  'gemini', 'gemini-embedding-2', 1536, 'active', 'normal', NULL, NULL, 'exact source', 'high'),
 ('aaaaaaa1-0000-4000-8000-000000000002', '99999999-9999-4999-8999-999999999991',
  'EVAL-RUST-NEW: I now prefer Rust for everything.', 'user_preference', public.eval_vec(0.8, 0, 0.6),
  'gemini', 'gemini-embedding-2', 1536, 'active', 'normal', NULL, NULL, 'contradicting source', 'medium'),
 ('aaaaaaa1-0000-4000-8000-000000000003', '99999999-9999-4999-8999-999999999991',
  'EVAL-THERAPY: Therapy appointment on Tuesdays.', 'important_event', public.eval_vec(0.9, 0, sqrt(0.19)),
  'gemini', 'gemini-embedding-2', 1536, 'active', 'sensitive', NULL, NULL, 'sensitive source', 'medium'),
 ('aaaaaaa1-0000-4000-8000-000000000004', '99999999-9999-4999-8999-999999999991',
  'EVAL-DELETED: should never be returned.', 'other', public.eval_vec(1, 0, 0),
  'gemini', 'gemini-embedding-2', 1536, 'deleted', 'normal', NULL, NULL, NULL, 'low'),
 ('aaaaaaa1-0000-4000-8000-000000000005', '99999999-9999-4999-8999-999999999991',
  'EVAL-SUPERSEDED: replaced by user confirmation.', 'other', public.eval_vec(1, 0, 0),
  'gemini', 'gemini-embedding-2', 1536, 'superseded', 'normal',
  'aaaaaaa1-0000-4000-8000-000000000001', NULL, NULL, 'low'),
 ('aaaaaaa1-0000-4000-8000-000000000006', '99999999-9999-4999-8999-999999999991',
  'EVAL-EXPIRED: expired fact.', 'other', public.eval_vec(1, 0, 0),
  'gemini', 'gemini-embedding-2', 1536, 'active', 'normal', NULL,
  now() - interval '1 day', NULL, 'low'),
 ('aaaaaaa1-0000-4000-8000-000000000007', '99999999-9999-4999-8999-999999999991',
  'EVAL-CREDENTIAL: sk-should-never-return', 'other', public.eval_vec(1, 0, 0),
  'gemini', 'gemini-embedding-2', 1536, 'active', 'credential', NULL, NULL, NULL, 'low'),
 ('aaaaaaa1-0000-4000-8000-000000000008', '99999999-9999-4999-8999-999999999992',
  'EVAL-OTHER-USER: other user secret fact.', 'personal_fact', public.eval_vec(1, 0, 0),
  'gemini', 'gemini-embedding-2', 1536, 'active', 'normal', NULL, NULL, NULL, 'high'),
 ('aaaaaaa1-0000-4000-8000-000000000009', '99999999-9999-4999-8999-999999999991',
  'EVAL-WEATHER: Weather forecast for tomorrow.', 'other', public.eval_vec(0, 0.3, sqrt(0.91)),
  'gemini', 'gemini-embedding-2', 1536, 'active', 'normal', NULL, NULL, NULL, 'low');

\echo ''
\echo '=== 1. Q1 — exact-match query (e1), threshold 0.65, count 10 ==='
\echo '    Expect: M1 (1.0), M3 (0.9), M2 (0.8) — nothing else.'
SELECT substring(content, 1, 28) AS memory,
       round(similarity::numeric, 3) AS sim
FROM public.match_memories(public.eval_vec(1, 0, 0),
                           '99999999-9999-4999-8999-999999999991', 0.65, 10);

\echo ''
\echo '=== 2. Q2 — strict threshold 0.85 ==='
\echo '    Expect: only M1 (1.0) and M3 (0.9); M2 (0.8) filtered out.'
SELECT substring(content, 1, 28) AS memory,
       round(similarity::numeric, 3) AS sim
FROM public.match_memories(public.eval_vec(1, 0, 0),
                           '99999999-9999-4999-8999-999999999991', 0.85, 10);

\echo ''
\echo '=== 3. Q3 — related-but-irrelevant query (e2), threshold 0.65 ==='
\echo '    Expect: 0 rows (weather memory sim 0.3 < 0.65; Python memory sim 0.0).'
SELECT count(*) AS rows_returned
FROM public.match_memories(public.eval_vec(0, 1, 0),
                           '99999999-9999-4999-8999-999999999991', 0.65, 10);

\echo ''
\echo '=== 4. Q4 — bounded results (count = 2) ==='
\echo '    Expect: exactly 2 rows, highest similarity first.'
SELECT count(*) AS rows_returned
FROM public.match_memories(public.eval_vec(1, 0, 0),
                           '99999999-9999-4999-8999-999999999991', 0.0, 2);

\echo ''
\echo '=== 5. Q5 — contradiction kept, NO automatic supersession ==='
\echo '    Expect: M1 AND M2 both returned; M1 still active, superseded_by NULL.'
SELECT substring(content, 1, 28) AS memory, round(similarity::numeric, 3) AS sim
FROM public.match_memories(public.eval_vec(1, 0, 0),
                           '99999999-9999-4999-8999-999999999991', 0.65, 10)
WHERE content LIKE 'EVAL-PY-PREF%' OR content LIKE 'EVAL-RUST-NEW%';
SELECT status, superseded_by, supersession_confirmed_by_user
FROM public.memories WHERE id = 'aaaaaaa1-0000-4000-8000-000000000001';

\echo ''
\echo '=== 6. Q6 — ownership isolation (query as U2) ==='
\echo '    Expect: only U2''s memory; never U1''s rows.'
SELECT substring(content, 1, 28) AS memory
FROM public.match_memories(public.eval_vec(1, 0, 0),
                           '99999999-9999-4999-8999-999999999992', 0.65, 10);

\echo ''
\echo '=== 7. RLS — authenticated role sees ONLY its own rows ==='
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '99999999-9999-4999-8999-999999999991', false);
\echo ' 7a. As U1: count of visible memories. RLS shows ALL 8 of U1''s rows'
\echo '     (incl. deleted/expired/credential — the FUNCTION applies those filters).'
SELECT count(*) AS u1_visible_rows FROM public.memories;
\echo ' 7b. As U1: rows visible that belong to U2 (expect 0).'
SELECT count(*) AS u2_rows_visible_to_u1 FROM public.memories
 WHERE user_id = '99999999-9999-4999-8999-999999999992';
\echo ' 7c. As U1: match_memories with p_user_id=U2 (expect 0 — RLS + ownership filter).'
SELECT count(*) AS cross_user_hits
FROM public.match_memories(public.eval_vec(1, 0, 0),
                           '99999999-9999-4999-8999-999999999992', 0.0, 10);
\echo ' 7d. As U1: UPDATE on U2''s memory row (expect 0 rows affected).'
UPDATE public.memories SET content = 'HACKED'
 WHERE id = 'aaaaaaa1-0000-4000-8000-000000000008';
SELECT count(*) AS u2_rows_hacked FROM public.memories
 WHERE content = 'HACKED';
\echo ' 7e. As U1: INSERT a memory FORGED with user_id=U2 (expect RLS WITH CHECK rejection).'
\set ON_ERROR_STOP off
INSERT INTO public.memories (user_id, content, category, embedding, embedding_dimensions)
VALUES ('99999999-9999-4999-8999-999999999992', 'EVAL-FORGED-OWNER', 'other', public.eval_vec(1, 0, 0), 1536);
\set ON_ERROR_STOP on
RESET ROLE;

\echo ''
\echo '=== 8. Worker functions are NOT callable by authenticated (expect permission denied) ==='
SET ROLE authenticated;
\set ON_ERROR_STOP off
SELECT count(*) FROM public.claim_memory_extraction_jobs(1);
\set ON_ERROR_STOP on
RESET ROLE;

-- Cleanup eval artifacts (leave the DB as found).
DELETE FROM public.memories WHERE content LIKE 'EVAL-%';
DELETE FROM auth.users WHERE email LIKE 'eval-%@example.com';  -- cascades to public.users
DROP FUNCTION public.eval_vec(float8, float8, float8);

\echo ''
\echo '=== Evaluation complete (eval rows cleaned up). ==='
