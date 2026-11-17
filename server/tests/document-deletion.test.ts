/**
 * M5 Corrective Patch 4 — document deletion lifecycle
 * ---------------------------------------------------
 * Full lifecycle coverage for deleting a Knowledge Base document:
 *
 *  1. owner requests deletion
 *  2. ownership is verified (foreign users cannot delete)
 *  3. the document becomes unavailable for retrieval and citation viewing
 *  4. chunks and vectors are removed
 *  5. the original storage object is deleted
 *  6. a failed storage delete is recoverable by the sweeper
 *  7. repeated deletion is idempotent
 *  8. other users' documents are untouched
 *  9. unrelated personal memories are untouched
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  deleteDocument,
  getDocumentViewLink,
  readDocumentBytes,
  getOwnedRow,
} from '../src/services/documents/document.service.js';
import {
  searchDocumentChunks,
  assertSearchableDocumentScope,
} from '../src/services/documents/retrieval.service.js';
import { createStorageProvider } from '../src/services/storage/index.js';
import type { StorageProvider } from '../src/services/storage/index.js';
import { sweepDeletingDocuments } from '../src/workers/document.worker.js';
import {
  resetFakeSupabase,
  registerUser,
  fakeDb,
  fakeStorage,
  fakeCreateUserScopedClient,
  seedStoredObject,
  injectStorageFailure,
  forceMatchSimilarity,
} from './helpers/fakeSupabase.js';
import type { FakeDocument, FakeDocumentChunk, FakeMemory } from './helpers/fakeSupabase.js';

const BUCKET = 'documents';
const USER_A = 'user-a';
const USER_B = 'user-b';
const TOKEN_A = 'token-a';
const TOKEN_B = 'token-b';

function nowIso(): string {
  return new Date().toISOString();
}

function seedDocument(overrides: Partial<FakeDocument> = {}): FakeDocument {
  const id = overrides.id ?? randomUUID();
  const row: FakeDocument = {
    id,
    user_id: USER_A,
    original_filename: 'guide.pdf',
    storage_filename: 'u.pdf',
    extension: 'pdf',
    mime_type: 'application/pdf',
    file_size: 1024,
    content_hash: randomUUID().replace(/-/g, ''),
    storage_path: `${overrides.user_id ?? USER_A}/${id}/u.pdf`,
    status: 'ready',
    page_count: 5,
    text_char_count: 1000,
    chunk_count: 1,
    extraction_metadata: {},
    error_message: null,
    deletion_attempts: 0,
    deletion_error: null,
    processing_started_at: null,
    processing_completed_at: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
  fakeDb.documents.push(row);
  seedStoredObject(BUCKET, row.storage_path, Buffer.from('%PDF-1.4 test %%EOF'), 'application/pdf');
  return row;
}

function seedChunk(doc: FakeDocument, overrides: Partial<FakeDocumentChunk> = {}): FakeDocumentChunk {
  const row: FakeDocumentChunk = {
    id: randomUUID(),
    document_id: doc.id,
    user_id: doc.user_id,
    chunk_index: 0,
    content: 'Skills: Python and SQL for data analysis.',
    embedding: Array.from({ length: 1536 }, () => 0.1),
    embedding_provider: 'gemini',
    embedding_model_version: 'gemini-embedding-2',
    embedding_dimensions: 1536,
    page_start: 1,
    page_end: 1,
    heading: 'Skills',
    section_path: '1 > Skills',
    paragraph_start: 0,
    paragraph_end: 1,
    char_start: 0,
    char_end: 40,
    token_estimate: 10,
    created_at: nowIso(),
    ...overrides,
  };
  fakeDb.document_chunks.push(row);
  return row;
}

function seedJob(doc: FakeDocument): void {
  fakeDb.document_processing_jobs.push({
    id: randomUUID(),
    document_id: doc.id,
    user_id: doc.user_id,
    status: 'completed',
    attempts: 1,
    max_attempts: 3,
    claimed_at: null,
    last_attempt_at: null,
    next_attempt_at: nowIso(),
    failed_at: null,
    error_message: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
}

function seedMemory(userId: string): FakeMemory {
  const row: FakeMemory = {
    id: randomUUID(),
    user_id: userId,
    content: 'The user prefers concise answers.',
    content_summary: null,
    category: 'preference',
    embedding_provider: 'gemini',
    embedding_model_version: 'gemini-embedding-2',
    embedding_dimensions: 1536,
    source_message_id: null,
    source_evidence: null,
    confidence: 'high',
    status: 'active',
    superseded_by: null,
    supersession_confirmed_by_user: false,
    sensitivity: 'normal',
    extraction_timestamp: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
    last_accessed_at: null,
    expired_at: null,
  };
  fakeDb.memories.push(row);
  return row;
}

/** Storage provider that delegates to the real fake-backed one and counts removes. */
function countingProvider(client: ReturnType<typeof fakeCreateUserScopedClient>): {
  provider: StorageProvider;
  removed: string[];
} {
  const real = createStorageProvider(client);
  const removed: string[] = [];
  const provider: StorageProvider = {
    kind: real.kind,
    put: (p, b, c) => real.put(p, b, c),
    get: (p) => real.get(p),
    remove: async (p) => {
      removed.push(p);
      return real.remove(p);
    },
    signedUrl: (p, ttl) => real.signedUrl(p, ttl),
  };
  return { provider, removed };
}

function findDoc(id: string): FakeDocument {
  const row = fakeDb.documents.find((d) => d.id === id);
  if (!row) throw new Error(`document ${id} missing`);
  return row;
}

describe('M5 Corrective Patch 4 — document deletion lifecycle', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN_A, USER_A, 'a@example.com');
    registerUser(TOKEN_B, USER_B, 'b@example.com');
  });

  it('deletes owned chunks, jobs and the storage object', async () => {
    const doc = seedDocument();
    const chunk = seedChunk(doc);
    seedJob(doc);
    const client = fakeCreateUserScopedClient(TOKEN_A);
    const { provider, removed } = countingProvider(client);

    const result = await deleteDocument(client, USER_A, doc.id, provider);

    expect(result.status).toBe('deleted');
    expect(findDoc(doc.id).status).toBe('deleted');
    expect(findDoc(doc.id).chunk_count).toBe(0);
    expect(fakeDb.document_chunks.find((c) => c.id === chunk.id)).toBeUndefined();
    expect(fakeDb.document_processing_jobs).toHaveLength(0);
    expect(removed).toEqual([doc.storage_path]);
    expect(fakeStorage.has(BUCKET, doc.storage_path)).toBe(false);
  });

  it('removes the document from retrieval and citation access', async () => {
    const doc = seedDocument();
    seedChunk(doc, { content: 'Python skills for data analysis' });
    const client = fakeCreateUserScopedClient(TOKEN_A);
    forceMatchSimilarity(0.9);

    // Retrieval works before deletion.
    const before = await searchDocumentChunks(client, USER_A, [0.1], {
      threshold: 0.5,
    });
    expect(before.length).toBe(1);

    await deleteDocument(client, USER_A, doc.id, createStorageProvider(client));

    // Retrieval no longer sees the document.
    const after = await searchDocumentChunks(client, USER_A, [0.1], {
      threshold: 0.5,
    });
    expect(after).toEqual([]);

    // Explicitly scoping a deleted id is a 404, not an empty result.
    await expect(
      assertSearchableDocumentScope(client, USER_A, [doc.id]),
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });

    // Citation viewer and content route are gone.
    await expect(getDocumentViewLink(client, USER_A, doc.id, createStorageProvider(client)))
      .rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(readDocumentBytes(client, USER_A, doc.id, createStorageProvider(client)))
      .rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('verifies ownership before deleting', async () => {
    const doc = seedDocument();
    seedChunk(doc);
    const foreignClient = fakeCreateUserScopedClient(TOKEN_B);

    await expect(
      deleteDocument(foreignClient, USER_B, doc.id, createStorageProvider(foreignClient)),
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });

    expect(findDoc(doc.id).status).toBe('ready');
    expect(fakeDb.document_chunks).toHaveLength(1);
    expect(fakeStorage.has(BUCKET, doc.storage_path)).toBe(true);

    // And getOwnedRow is still a 404 for the foreign user.
    await expect(getOwnedRow(foreignClient, USER_B, doc.id)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
  });

  it('is idempotent on repeated deletion', async () => {
    const doc = seedDocument();
    seedChunk(doc);
    const client = fakeCreateUserScopedClient(TOKEN_A);
    const { provider, removed } = countingProvider(client);

    await deleteDocument(client, USER_A, doc.id, provider);
    const second = await deleteDocument(client, USER_A, doc.id, provider);

    expect(second.status).toBe('deleted');
    expect(removed).toHaveLength(1); // storage removed only once
    expect(findDoc(doc.id).status).toBe('deleted');
  });

  it('recovers a failed storage deletion via the sweeper', async () => {
    const doc = seedDocument();
    seedChunk(doc);
    const client = fakeCreateUserScopedClient(TOKEN_A);
    injectStorageFailure('remove', 'storage temporarily unavailable');

    const first = await deleteDocument(client, USER_A, doc.id, createStorageProvider(client));

    expect(first.status).toBe('deleting');
    const pending = findDoc(doc.id);
    expect(pending.status).toBe('deleting');
    expect(pending.deletion_attempts).toBe(1);
    expect(pending.deletion_error).toBe('STORAGE_DELETE_FAILED');
    // Chunks must already be gone; only the object delete failed.
    expect(fakeDb.document_chunks).toHaveLength(0);

    const swept = await sweepDeletingDocuments({ client });

    expect(swept).toBe(1);
    expect(findDoc(doc.id).status).toBe('deleted');
    expect(findDoc(doc.id).deletion_error).toBeNull();
    expect(fakeStorage.has(BUCKET, doc.storage_path)).toBe(false);
  });

  it('leaves other users\' documents untouched', async () => {
    const mine = seedDocument();
    seedChunk(mine);
    const theirs = seedDocument({
      user_id: USER_B,
      original_filename: 'private-b.pdf',
    });
    const theirChunk = seedChunk(theirs, { user_id: USER_B });

    const client = fakeCreateUserScopedClient(TOKEN_A);
    await deleteDocument(client, USER_A, mine.id, createStorageProvider(client));

    expect(findDoc(mine.id).status).toBe('deleted');
    expect(findDoc(theirs.id).status).toBe('ready');
    expect(fakeDb.document_chunks.find((c) => c.id === theirChunk.id)).toBeTruthy();
    expect(fakeStorage.has(BUCKET, theirs.storage_path)).toBe(true);
  });

  it('does not delete unrelated personal memories', async () => {
    const doc = seedDocument();
    seedChunk(doc);
    const memory = seedMemory(USER_A);

    const client = fakeCreateUserScopedClient(TOKEN_A);
    await deleteDocument(client, USER_A, doc.id, createStorageProvider(client));

    expect(fakeDb.memories.find((m) => m.id === memory.id)).toBeTruthy();
    expect(fakeDb.memories).toHaveLength(1);
  });
});
