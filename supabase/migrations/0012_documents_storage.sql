-- ============================================================
-- Migration: 0012_documents_storage.sql
-- Description: Private storage bucket for Knowledge Base uploads.
--
--   This migration is Supabase-specific: buckets and storage policies
--   live in the `storage` schema, which plain PostgreSQL (the local
--   verification harness) does not have. The whole body is therefore
--   guarded: on a database without that schema it logs a notice and
--   does nothing, so 0011/0012 can be applied unchanged everywhere.
--
--   Security model:
--     - Bucket `documents` is PRIVATE (public = false). No public URLs.
--     - Objects are keyed '{user_id}/{document_id}/{uuid}.{ext}'.
--     - Storage RLS compares the first path segment to auth.uid(), so
--       a user's JWT can only read/write inside their own folder.
--     - Access from the API uses the user-scoped Supabase client
--       (storage RLS applies). The background worker uses the service
--       role, which bypasses storage RLS by design.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage'
  ) THEN
    RAISE NOTICE
      'storage schema absent (plain PostgreSQL); skipping documents bucket setup';
    RETURN;
  END IF;

  -- ----------------------------------------------------------
  -- 1. Private bucket with hard limits enforced by storage.
  -- ----------------------------------------------------------
  EXECUTE $sql$
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'documents',
      'documents',
      false,
      26214400, -- 25 MiB
      ARRAY[
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain'
      ]
    )
    ON CONFLICT (id) DO UPDATE
      SET public = false,
          file_size_limit = EXCLUDED.file_size_limit,
          allowed_mime_types = EXCLUDED.allowed_mime_types
  $sql$;

  -- ----------------------------------------------------------
  -- 2. Storage object policies (owner = first path segment).
  -- ----------------------------------------------------------
  EXECUTE $sql$ DROP POLICY IF EXISTS documents_objects_select_own ON storage.objects $sql$;
  EXECUTE $sql$
    CREATE POLICY documents_objects_select_own ON storage.objects
      FOR SELECT
      USING (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;

  EXECUTE $sql$ DROP POLICY IF EXISTS documents_objects_insert_own ON storage.objects $sql$;
  EXECUTE $sql$
    CREATE POLICY documents_objects_insert_own ON storage.objects
      FOR INSERT
      WITH CHECK (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;

  EXECUTE $sql$ DROP POLICY IF EXISTS documents_objects_update_own ON storage.objects $sql$;
  EXECUTE $sql$
    CREATE POLICY documents_objects_update_own ON storage.objects
      FOR UPDATE
      USING (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
      WITH CHECK (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;

  EXECUTE $sql$ DROP POLICY IF EXISTS documents_objects_delete_own ON storage.objects $sql$;
  EXECUTE $sql$
    CREATE POLICY documents_objects_delete_own ON storage.objects
      FOR DELETE
      USING (
        bucket_id = 'documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
      )
  $sql$;

  RAISE NOTICE 'documents bucket + storage policies applied';
END $$;

-- ============================================================
-- End of 0012_documents_storage.sql
-- ============================================================
