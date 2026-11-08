-- ============================================================
-- Migration: 0011_documents_schema.sql
-- Description: Personal Knowledge Base (Milestone 5).
--
--   ADDITIVE migration. It creates a document store that is fully
--   separate from the personal-memory engine:
--
--     1. `public.documents`              — uploaded document metadata
--     2. `public.document_chunks`        — extracted text + vector(1536)
--     3. `public.document_processing_jobs` — durable processing outbox
--
--   Plus:
--     - HNSW cosine index on document_chunks.embedding (same 1536-dim
--       Gemini Embedding 2 space as `memories`, but a SEPARATE index —
--       document chunks never enter `memories` and vice versa).
--     - RLS ("auth.uid() = user_id") on all three tables.
--     - `match_document_chunks()` — RPC retrieval with proven ownership,
--       ready-only filtering, optional document ids, strict limits.
--     - `claim_document_processing_jobs()` /
--       `recover_stale_document_jobs()` — worker-only atomic claim,
--       stale recovery, bounded retries (SECURITY DEFINER + fixed
--       search_path, executable by service_role only).
--
--   No existing table, policy, index or function is modified.
--   Requires: pgvector (already enabled by 0005).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------
-- 1. documents — original upload metadata (binaries live in
--    private object storage, never in PostgreSQL).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.documents (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  -- User-facing name (normalised server-side) and the safe object name.
  original_filename       text NOT NULL,
  storage_filename        text NOT NULL,
  extension               text NOT NULL
                            CHECK (extension IN ('pdf', 'docx', 'txt')),
  -- Detected server-side from magic bytes; the browser value is advisory.
  mime_type               text NOT NULL
                            CHECK (mime_type IN (
                              'application/pdf',
                              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                              'text/plain'
                            )),
  file_size               bigint NOT NULL CHECK (file_size > 0),
  content_hash            text NOT NULL CHECK (length(content_hash) = 64), -- sha256 hex

  -- Object key: '{user_id}/{document_id}/{storage_filename}'.
  -- The LIKE check makes it structurally impossible to persist a path
  -- that points at another user's folder.
  storage_path            text NOT NULL,

  status                  text NOT NULL DEFAULT 'uploaded'
                            CHECK (status IN (
                              'uploaded', 'pending', 'processing',
                              'ready', 'failed', 'deleting', 'deleted'
                            )),

  page_count              int,
  text_char_count          int,
  chunk_count             int NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  extraction_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,

  error_message           text,   -- stable code + short safe detail, never content
  deletion_attempts       int NOT NULL DEFAULT 0 CHECK (deletion_attempts >= 0),
  deletion_error          text,

  processing_started_at   timestamptz,
  processing_completed_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT documents_filename_len
    CHECK (length(btrim(original_filename)) BETWEEN 1 AND 255),
  CONSTRAINT documents_storage_path_owned
    CHECK (storage_path LIKE user_id::text || '/%'),
  CONSTRAINT documents_storage_filename_safe
    CHECK (storage_filename !~ '[/\\]' AND length(storage_filename) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS idx_documents_user_created
  ON public.documents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_user_status
  ON public.documents (user_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_user_hash
  ON public.documents (user_id, content_hash);
-- Duplicate detection only among LIVE rows so a deleted file can be
-- re-uploaded while an in-flight duplicate cannot be created twice.
CREATE UNIQUE INDEX IF NOT EXISTS documents_user_hash_unique
  ON public.documents (user_id, content_hash)
  WHERE status IN ('uploaded', 'pending', 'processing', 'ready', 'failed');
CREATE INDEX IF NOT EXISTS idx_documents_deleting
  ON public.documents (status) WHERE status = 'deleting';

-- ------------------------------------------------------------
-- 2. document_chunks — extracted, chunked, embedded content.
--    Provenance is stored per chunk: page range (PDF), heading /
--    section path, paragraph range, character offsets.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_chunks (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id             uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  chunk_index             int  NOT NULL CHECK (chunk_index >= 0),
  content                 text NOT NULL CHECK (length(btrim(content)) > 0),

  embedding               vector(1536),  -- NULL until embedded
  embedding_provider      text NOT NULL DEFAULT 'gemini',
  embedding_model_version text NOT NULL DEFAULT 'gemini-embedding-2',
  embedding_dimensions    int  NOT NULL DEFAULT 1536
                            CHECK (embedding_dimensions = 1536),

  page_start              int CHECK (page_start IS NULL OR page_start >= 1),
  page_end                int CHECK (page_end IS NULL OR page_end >= 1),
  heading                 text,
  section_path            text,
  paragraph_start         int CHECK (paragraph_start IS NULL OR paragraph_start >= 0),
  paragraph_end           int CHECK (paragraph_end IS NULL OR paragraph_end >= 0),
  char_start              int CHECK (char_start IS NULL OR char_start >= 0),
  char_end                int CHECK (char_end IS NULL OR char_end >= 0),
  token_estimate          int CHECK (token_estimate IS NULL OR token_estimate >= 0),

  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT document_chunks_unique_index UNIQUE (document_id, chunk_index),
  CONSTRAINT document_chunks_page_order
    CHECK (page_start IS NULL OR page_end IS NULL OR page_end >= page_start),
  CONSTRAINT document_chunks_char_order
    CHECK (char_start IS NULL OR char_end IS NULL OR char_end >= char_start)
);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding_cosine
  ON public.document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_document
  ON public.document_chunks (document_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_chunks_user_document
  ON public.document_chunks (user_id, document_id);

-- ------------------------------------------------------------
-- 3. document_processing_jobs — durable outbox.
--    One colour of state lives in the database, not in memory:
--    a worker crash cannot lose or duplicate a job.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_processing_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  attempts        int  NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    int  NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),

  claimed_at      timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  failed_at       timestamptz,
  error_message   text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doc_jobs_claim
  ON public.document_processing_jobs (next_attempt_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_doc_jobs_user
  ON public.document_processing_jobs (user_id, status);
-- At most ONE active job per document: duplicate processing is
-- impossible at the schema level, not just in application code.
CREATE UNIQUE INDEX IF NOT EXISTS doc_jobs_one_active
  ON public.document_processing_jobs (document_id)
  WHERE status IN ('pending', 'claimed');

-- ------------------------------------------------------------
-- 4. updated_at triggers (reuses the existing public.set_updated_at)
-- ------------------------------------------------------------
DROP TRIGGER IF EXISTS documents_set_updated_at ON public.documents;
CREATE TRIGGER documents_set_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS document_jobs_set_updated_at ON public.document_processing_jobs;
CREATE TRIGGER document_jobs_set_updated_at
  BEFORE UPDATE ON public.document_processing_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 5. Grants + RLS
--    Same pattern as memories: table-level CRUD for `authenticated`
--    (constrained by RLS) and `service_role` (worker, bypasses RLS).
-- ------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents
  TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_chunks
  TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_processing_jobs
  TO authenticated, service_role;

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_select_own ON public.documents;
CREATE POLICY documents_select_own ON public.documents
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS documents_insert_own ON public.documents;
CREATE POLICY documents_insert_own ON public.documents
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS documents_update_own ON public.documents;
CREATE POLICY documents_update_own ON public.documents
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS documents_delete_own ON public.documents;
CREATE POLICY documents_delete_own ON public.documents
  FOR DELETE USING (auth.uid() = user_id);

ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_chunks_select_own ON public.document_chunks;
CREATE POLICY document_chunks_select_own ON public.document_chunks
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS document_chunks_insert_own ON public.document_chunks;
CREATE POLICY document_chunks_insert_own ON public.document_chunks
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS document_chunks_update_own ON public.document_chunks;
CREATE POLICY document_chunks_update_own ON public.document_chunks
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS document_chunks_delete_own ON public.document_chunks;
CREATE POLICY document_chunks_delete_own ON public.document_chunks
  FOR DELETE USING (auth.uid() = user_id);

ALTER TABLE public.document_processing_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_jobs_select_own ON public.document_processing_jobs;
CREATE POLICY doc_jobs_select_own ON public.document_processing_jobs
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS doc_jobs_insert_own ON public.document_processing_jobs;
CREATE POLICY doc_jobs_insert_own ON public.document_processing_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS doc_jobs_update_own ON public.document_processing_jobs;
CREATE POLICY doc_jobs_update_own ON public.document_processing_jobs
  FOR UPDATE USING (auth.uid() = user_id);
DROP POLICY IF EXISTS doc_jobs_delete_own ON public.document_processing_jobs;
CREATE POLICY doc_jobs_delete_own ON public.document_processing_jobs
  FOR DELETE USING (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 6. match_document_chunks — retrieval RPC.
--    SECURITY INVOKER so RLS still applies to the caller; the
--    p_user_id filter is belt-and-braces. Only READY documents with
--    a non-null embedding are searchable, so a document being
--    deleted stops being retrievable the moment its status changes.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_document_chunks(
  query_embedding vector(1536),
  p_user_id uuid,
  match_threshold float DEFAULT 0.50,
  match_count int DEFAULT 8,
  p_document_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  user_id uuid,
  content text,
  similarity float,
  chunk_index int,
  page_start int,
  page_end int,
  heading text,
  section_path text,
  char_start int,
  char_end int,
  original_filename text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    c.id            AS chunk_id,
    c.document_id   AS document_id,
    c.user_id       AS user_id,
    c.content       AS content,
    1 - (c.embedding <=> query_embedding) AS similarity,
    c.chunk_index   AS chunk_index,
    c.page_start    AS page_start,
    c.page_end      AS page_end,
    c.heading       AS heading,
    c.section_path  AS section_path,
    c.char_start    AS char_start,
    c.char_end      AS char_end,
    d.original_filename AS original_filename
  FROM public.document_chunks c
  JOIN public.documents d ON d.id = c.document_id
  WHERE c.user_id = p_user_id
    AND d.user_id = p_user_id
    AND d.status = 'ready'
    AND c.embedding IS NOT NULL
    AND (p_document_ids IS NULL OR c.document_id = ANY (p_document_ids))
    AND (1 - (c.embedding <=> query_embedding)) >= match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 50);
$$;

-- No PUBLIC execute. The worker also retrieves during evaluation, so
-- service_role is granted alongside authenticated (M4.2 lesson).
REVOKE ALL ON FUNCTION public.match_document_chunks(vector, uuid, float, int, uuid[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_document_chunks(vector, uuid, float, int, uuid[])
  TO authenticated, service_role;

-- ------------------------------------------------------------
-- 7. Worker-only queue functions.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_document_processing_jobs(p_limit int DEFAULT 5)
RETURNS SETOF public.document_processing_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Recover stale claims first so an interrupted worker's jobs are
  -- claimable again on this tick.
  PERFORM public.recover_stale_document_jobs(300);

  -- Atomically claim due pending jobs. SKIP LOCKED makes concurrent
  -- workers safe; attempts increments at claim time, so a crash
  -- mid-processing still consumes an attempt (bounded retries).
  RETURN QUERY
  UPDATE public.document_processing_jobs j
  SET status = 'claimed',
      claimed_at = now(),
      last_attempt_at = now(),
      attempts = j.attempts + 1,
      updated_at = now()
  WHERE j.id IN (
    SELECT id
    FROM public.document_processing_jobs
    WHERE status = 'pending'
      AND next_attempt_at <= now()
    ORDER BY next_attempt_at ASC, created_at ASC
    LIMIT LEAST(GREATEST(p_limit, 1), 20)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING j.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_stale_document_jobs(p_stale_seconds int DEFAULT 300)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recovered int;
BEGIN
  -- Claimed jobs older than the staleness window: retry, or fail once
  -- attempts are exhausted. No job is ever left in 'claimed' forever.
  UPDATE public.document_processing_jobs
  SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
      claimed_at = NULL,
      failed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE failed_at END,
      error_message = CASE
        WHEN attempts >= max_attempts THEN 'STALE_JOB_ATTEMPTS_EXHAUSTED'
        ELSE error_message
      END,
      updated_at = now()
  WHERE status = 'claimed'
    AND claimed_at IS NOT NULL
    AND claimed_at < now() - make_interval(secs => GREATEST(p_stale_seconds, 1));
  GET DIAGNOSTICS recovered = ROW_COUNT;

  -- Keep document status coherent with the queue: a document stuck in
  -- pending/processing with no live job is marked failed (honest state)
  -- instead of showing "processing" forever.
  UPDATE public.documents d
  SET status = 'failed',
      error_message = COALESCE(d.error_message, 'PROCESSING_INTERRUPTED'),
      updated_at = now()
  WHERE d.status IN ('pending', 'processing')
    AND NOT EXISTS (
      SELECT 1
      FROM public.document_processing_jobs j
      WHERE j.document_id = d.id
        AND j.status IN ('pending', 'claimed')
    );

  RETURN recovered;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_document_processing_jobs(int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_processing_jobs(int)
  TO service_role;

REVOKE ALL ON FUNCTION public.recover_stale_document_jobs(int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_document_jobs(int)
  TO service_role;

-- ============================================================
-- End of 0011_documents_schema.sql
-- ============================================================
