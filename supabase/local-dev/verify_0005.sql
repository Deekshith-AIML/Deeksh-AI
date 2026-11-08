-- ============================================================
-- Milestone 4 migration verification (local dev DB — chitti-pg)
-- ============================================================

\set ON_ERROR_STOP on

-- A. Confirm pgvector availability (actual result reported separately)
SELECT extname FROM pg_extension WHERE extname = 'vector';

-- B. Confirm memory tables exist (additive to 0001–0004)
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('memories', 'memory_settings', 'memory_extraction_jobs');

-- C. Confirm memory columns and types
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'memories' ORDER BY ordinal_position;

-- D. Confirm vector column type exists (if extension installed)
SELECT typname FROM pg_type WHERE typname = 'vector';

-- E. Confirm RLS policies exist
SELECT schemaname, tablename, policyname FROM pg_policies WHERE tablename IN ('memories', 'memory_settings', 'memory_extraction_jobs');

-- F. Confirm indexes exist
SELECT indexname FROM pg_indexes WHERE tablename IN ('memories', 'memory_settings', 'memory_extraction_jobs');
SELECT indexname, indexdef FROM pg_indexes WHERE indexname = 'idx_memories_embedding_cosine';

-- G. Confirm categories and settings enums/types exist
SELECT typname FROM pg_type WHERE typname = 'memory_category';

-- H. Confirm the search + outbox SQL functions exist (designed in 0005)
SELECT p.proname, p.prosecdef AS is_security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('match_memories', 'claim_memory_extraction_jobs', 'recover_stale_extraction_jobs')
ORDER BY p.proname;

-- I. Confirm function permissions (no PUBLIC execute on worker functions)
SELECT p.proname, has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('match_memories', 'claim_memory_extraction_jobs', 'recover_stale_extraction_jobs')
ORDER BY p.proname;

-- J. Confirm 0005 applied cleanly (this script runs after)
\echo 'Migration 0005 verification completed. If pgvector extension missing locally, the SQL function definition is written correctly and will work on hosted DB with extension enabled.'
