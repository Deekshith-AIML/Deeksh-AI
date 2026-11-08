import { describe, it, expect, beforeEach, vi } from 'vitest';
import { embedAndPersistChunks, deleteDocumentChunks } from '../src/services/documents/chunk-embedding.service.js';
import { resetFakeSupabase, registerUser, fakeDb, forceMatchSimilarity } from '../tests/helpers/fakeSupabase.js';
import { fakeCreateUserScopedClient } from '../tests/helpers/fakeSupabase.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';

// Mock embedding service to use deterministic mock embeddings.
vi.mock('../src/services/embedding.service.js', () => ({
  embed: async (text: string) => {
    if (text.includes('__FAIL__')) throw new Error('RATE_LIMIT');
    return Array.from({ length: 1536 }, (_, i) => (i * 0.001 + text.length * 0.0001));
  },
  getActiveSpace: () => ({ provider: 'gemini', model: 'gemini-embedding-2', dimension: 1536 }),
  assertStorableInIndex: () => {},
}));

const config = getDocumentsConfig();

describe('M5 Phase 5 chunk embedding', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser('token-1', 'user-1', 'user1@test.com');
  });

  it('persists chunks with embeddings', async () => {
    const client = fakeCreateUserScopedClient('token-1');
    const chunks = [
      {
        documentId: 'doc-1',
        userId: 'user-1',
        chunkIndex: 0,
        content: 'Hello world',
        pageStart: 1,
        pageEnd: 1,
        heading: null,
        sectionPath: null,
        paragraphStart: 0,
        paragraphEnd: 0,
        charStart: 0,
        charEnd: 11,
        tokenEstimate: 3,
      },
      {
        documentId: 'doc-1',
        userId: 'user-1',
        chunkIndex: 1,
        content: 'Second chunk',
        pageStart: 2,
        pageEnd: 2,
        heading: null,
        sectionPath: null,
        paragraphStart: 1,
        paragraphEnd: 1,
        charStart: 13,
        charEnd: 25,
        tokenEstimate: 3,
      },
    ];

    const persisted = await embedAndPersistChunks(client, 'doc-1', 'user-1', chunks, config);
    expect(persisted.length).toBe(2);
    expect(persisted[0].embedding).not.toBeNull();
    expect(persisted[0].embedding!.length).toBe(1536);
    expect(persisted[0].embedding_provider).toBe('gemini');
    expect(persisted[0].embedding_model_version).toBe('gemini-embedding-2');
    expect(persisted[0].embedding_dimensions).toBe(1536);
  });

  it('deletes existing chunks before re-persisting (idempotent)', async () => {
    const client = fakeCreateUserScopedClient('token-1');
    const chunks = [
      {
        documentId: 'doc-1',
        userId: 'user-1',
        chunkIndex: 0,
        content: 'First',
        pageStart: 1,
        pageEnd: 1,
        heading: null,
        sectionPath: null,
        paragraphStart: 0,
        paragraphEnd: 0,
        charStart: 0,
        charEnd: 5,
        tokenEstimate: 2,
      },
    ];

    await embedAndPersistChunks(client, 'doc-1', 'user-1', chunks, config);
    expect(fakeDb.document_chunks.length).toBe(1);

    // Re-persist with different content.
    const chunks2 = [
      {
        documentId: 'doc-1',
        userId: 'user-1',
        chunkIndex: 0,
        content: 'Updated',
        pageStart: 1,
        pageEnd: 1,
        heading: null,
        sectionPath: null,
        paragraphStart: 0,
        paragraphEnd: 0,
        charStart: 0,
        charEnd: 7,
        tokenEstimate: 2,
      },
    ];
    await embedAndPersistChunks(client, 'doc-1', 'user-1', chunks2, config);
    expect(fakeDb.document_chunks.length).toBe(1);
    expect(fakeDb.document_chunks[0].content).toBe('Updated');
  });

  it('deleteDocumentChunks removes all chunks', async () => {
    const client = fakeCreateUserScopedClient('token-1');
    const chunks = [
      {
        documentId: 'doc-1',
        userId: 'user-1',
        chunkIndex: 0,
        content: 'Hello',
        pageStart: 1,
        pageEnd: 1,
        heading: null,
        sectionPath: null,
        paragraphStart: 0,
        paragraphEnd: 0,
        charStart: 0,
        charEnd: 5,
        tokenEstimate: 2,
      },
    ];
    await embedAndPersistChunks(client, 'doc-1', 'user-1', chunks, config);
    expect(fakeDb.document_chunks.length).toBe(1);

    await deleteDocumentChunks(client, 'doc-1', 'user-1');
    expect(fakeDb.document_chunks.length).toBe(0);
  });

  it('throws on embedding failure', async () => {
    const client = fakeCreateUserScopedClient('token-1');
    const chunks = [
      {
        documentId: 'doc-1',
        userId: 'user-1',
        chunkIndex: 0,
        content: '__FAIL__',
        pageStart: 1,
        pageEnd: 1,
        heading: null,
        sectionPath: null,
        paragraphStart: 0,
        paragraphEnd: 0,
        charStart: 0,
        charEnd: 8,
        tokenEstimate: 2,
      },
    ];

    await expect(embedAndPersistChunks(client, 'doc-1', 'user-1', chunks, config)).rejects.toThrow();
  });
});
