import { describe, it, expect, beforeEach, vi } from 'vitest';
import { deleteDocument } from '../src/services/documents/document.service.js';
import { resetFakeSupabase, registerUser, fakeDb } from '../tests/helpers/fakeSupabase.js';
import { fakeCreateUserScopedClient } from '../tests/helpers/fakeSupabase.js';
import { createStorageProvider } from '../src/services/storage/index.js';

// Mock storage provider to use local adapter.
vi.mock('../src/services/storage/index.js', () => ({
  createStorageProvider: () => ({
    kind: 'local',
    put: async () => {},
    get: async () => Buffer.from(''),
    remove: async () => {},
    signedUrl: async () => null,
  }),
}));

describe('M5 Phase 11 deletion', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser('token-1', 'user-1', 'user1@test.com');
    registerUser('token-2', 'user-2', 'user2@test.com');
  });

  it('deletes a document and removes chunks', async () => {
    const client = fakeCreateUserScopedClient('token-1');

    // Seed a ready document.
    fakeDb.documents.push({
      id: 'doc-1',
      user_id: 'user-1',
      original_filename: 'guide.pdf',
      storage_filename: 'u.pdf',
      extension: 'pdf',
      mime_type: 'application/pdf',
      file_size: 1000,
      content_hash: 'a'.repeat(64),
      storage_path: 'user-1/doc-1/u.pdf',
      status: 'ready',
      page_count: 5,
      text_char_count: 1000,
      chunk_count: 2,
      extraction_metadata: {},
      error_message: null,
      deletion_attempts: 0,
      deletion_error: null,
      processing_started_at: null,
      processing_completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    fakeDb.document_chunks.push({
      id: 'chunk-1',
      document_id: 'doc-1',
      user_id: 'user-1',
      chunk_index: 0,
      content: 'Skills: Python',
      embedding: Array.from({ length: 1536 }, () => 0.5),
      embedding_provider: 'gemini',
      embedding_model_version: 'gemini-embedding-2',
      embedding_dimensions: 1536,
      page_start: 4,
      page_end: 4,
      heading: 'Skills',
      section_path: '2 > Skills',
      paragraph_start: 0,
      paragraph_end: 0,
      char_start: 0,
      char_end: 14,
      token_estimate: 4,
      created_at: new Date().toISOString(),
    });

    const storage = createStorageProvider(client);
    const result = await deleteDocument(client, 'user-1', 'doc-1', storage);
    expect(result.status).toBe('deleted');
    expect(fakeDb.document_chunks.length).toBe(0);
  });

  it('prevents cross-user deletion', async () => {
    const client = fakeCreateUserScopedClient('token-2');

    fakeDb.documents.push({
      id: 'doc-1',
      user_id: 'user-1',
      original_filename: 'guide.pdf',
      storage_filename: 'u.pdf',
      extension: 'pdf',
      mime_type: 'application/pdf',
      file_size: 1000,
      content_hash: 'a'.repeat(64),
      storage_path: 'user-1/doc-1/u.pdf',
      status: 'ready',
      page_count: 5,
      text_char_count: 1000,
      chunk_count: 2,
      extraction_metadata: {},
      error_message: null,
      deletion_attempts: 0,
      deletion_error: null,
      processing_started_at: null,
      processing_completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const storage = createStorageProvider(client);
    await expect(deleteDocument(client, 'user-2', 'doc-1', storage)).rejects.toThrow();
  });

  it('is idempotent for already-deleted documents', async () => {
    const client = fakeCreateUserScopedClient('token-1');

    fakeDb.documents.push({
      id: 'doc-1',
      user_id: 'user-1',
      original_filename: 'guide.pdf',
      storage_filename: 'u.pdf',
      extension: 'pdf',
      mime_type: 'application/pdf',
      file_size: 1000,
      content_hash: 'a'.repeat(64),
      storage_path: 'user-1/doc-1/u.pdf',
      status: 'deleted',
      page_count: 5,
      text_char_count: 1000,
      chunk_count: 0,
      extraction_metadata: {},
      error_message: null,
      deletion_attempts: 0,
      deletion_error: null,
      processing_started_at: null,
      processing_completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const storage = createStorageProvider(client);
    const result = await deleteDocument(client, 'user-1', 'doc-1', storage);
    expect(result.status).toBe('deleted');
  });
});
