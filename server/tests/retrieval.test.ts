import { describe, it, expect, beforeEach } from 'vitest';
import { searchDocumentChunks } from '../src/services/documents/retrieval.service.js';
import { resetFakeSupabase, registerUser, fakeDb } from '../tests/helpers/fakeSupabase.js';
import { fakeCreateUserScopedClient } from '../tests/helpers/fakeSupabase.js';

describe('M5 Phase 7 retrieval', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser('token-1', 'user-1', 'user1@test.com');
    registerUser('token-2', 'user-2', 'user2@test.com');

    // Seed a ready document with chunks.
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

    fakeDb.document_chunks.push(
      {
        id: 'chunk-1',
        document_id: 'doc-1',
        user_id: 'user-1',
        chunk_index: 0,
        content: 'Skills: Python, SQL, data visualization',
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
        char_end: 40,
        token_estimate: 10,
        created_at: new Date().toISOString(),
      },
      {
        id: 'chunk-2',
        document_id: 'doc-1',
        user_id: 'user-1',
        chunk_index: 1,
        content: 'Tools: Jupyter, Tableau, Power BI',
        embedding: Array.from({ length: 1536 }, () => 0.3),
        embedding_provider: 'gemini',
        embedding_model_version: 'gemini-embedding-2',
        embedding_dimensions: 1536,
        page_start: 7,
        page_end: 7,
        heading: 'Tools',
        section_path: '3 > Tools',
        paragraph_start: 1,
        paragraph_end: 1,
        char_start: 42,
        char_end: 75,
        token_estimate: 8,
        created_at: new Date().toISOString(),
      },
    );
  });

  it('returns chunks for the owning user', async () => {
    const client = fakeCreateUserScopedClient('token-1');
    const embedding = Array.from({ length: 1536 }, () => 0.5);
    const results = await searchDocumentChunks(client, 'user-1', embedding, { threshold: 0.1 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].userId).toBe('user-1');
    expect(results[0].filename).toBe('guide.pdf');
  });

  it('excludes other users chunks', async () => {
    const client = fakeCreateUserScopedClient('token-2');
    const embedding = Array.from({ length: 1536 }, () => 0.5);
    const results = await searchDocumentChunks(client, 'user-2', embedding, { threshold: 0.1 });
    expect(results.length).toBe(0);
  });

  it('excludes non-ready documents', async () => {
    fakeDb.documents[0].status = 'processing';
    const client = fakeCreateUserScopedClient('token-1');
    const embedding = Array.from({ length: 1536 }, () => 0.5);
    const results = await searchDocumentChunks(client, 'user-1', embedding, { threshold: 0.1 });
    expect(results.length).toBe(0);
  });

  it('filters by document ids', async () => {
    const client = fakeCreateUserScopedClient('token-1');
    const embedding = Array.from({ length: 1536 }, () => 0.5);
    const results = await searchDocumentChunks(client, 'user-1', embedding, {
      documentIds: ['nonexistent-doc'],
      threshold: 0.1,
    });
    expect(results.length).toBe(0);
  });

  it('preserves provenance', async () => {
    const client = fakeCreateUserScopedClient('token-1');
    const embedding = Array.from({ length: 1536 }, () => 0.5);
    const results = await searchDocumentChunks(client, 'user-1', embedding, { threshold: 0.1 });
    expect(results[0].pageStart).toBe(4);
    expect(results[0].heading).toBe('Skills');
    expect(results[0].sectionPath).toBe('2 > Skills');
  });

  it('excludes deleted documents', async () => {
    fakeDb.documents[0].status = 'deleted';
    const client = fakeCreateUserScopedClient('token-1');
    const embedding = Array.from({ length: 1536 }, () => 0.5);
    const results = await searchDocumentChunks(client, 'user-1', embedding, { threshold: 0.1 });
    expect(results.length).toBe(0);
  });
});
