/**
 * tests/document-search.test.ts
 * -----------------------------
 * Milestone 5 corrective patch 3 — document search API and secure viewer
 * endpoints.
 *
 * Covers search validation, auth, ownership/scoping, embedding and database
 * failures, deleted/unprocessed exclusion, result bounds, and the citation
 * viewer's authorization checks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

const { embeddingState } = vi.hoisted(() => ({
  embeddingState: { fail: false },
}));

// Keep the real deterministic test embedding, but allow a provider outage.
vi.mock('../src/services/embedding.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/embedding.service.js')>();
  return {
    ...actual,
    embed: async (...args: Parameters<typeof actual.embed>) => {
      if (embeddingState.fail) {
        throw new actual.EmbeddingServiceError('simulated provider outage', 'FAIL');
      }
      return actual.embed(...args);
    },
  };
});

vi.mock('../src/services/supabase.service.js', async () => {
  const { fakeCreateUserScopedClient } = await import('./helpers/fakeSupabase.js');
  return {
    createUserScopedClient: fakeCreateUserScopedClient,
    createAdminClient: () => {
      throw new Error('admin client unavailable in tests');
    },
  };
});

import app from '../src/app.js';
import {
  registerUser,
  resetFakeSupabase,
  injectDatabaseFailure,
  seedStoredObject,
  forceMatchSimilarity,
  fakeDb,
} from './helpers/fakeSupabase.js';
import { resetRateLimits } from '../src/middleware/rate-limit.middleware.js';

const TOKEN_A = 'headerA.payloadA.signatureA';
const TOKEN_B = 'headerB.payloadB.signatureB';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const authA = () => ({ Authorization: `Bearer ${TOKEN_A}` });

interface SeedDocOptions {
  id?: string;
  userId?: string;
  filename?: string;
  status?: string;
  extension?: 'pdf' | 'docx' | 'txt';
  pageCount?: number | null;
}

function seedDocument(options: SeedDocOptions = {}) {
  const id = options.id ?? randomUUID();
  const userId = options.userId ?? USER_A;
  const extension = options.extension ?? 'pdf';
  const row = {
    id,
    user_id: userId,
    original_filename: options.filename ?? `guide-${id.slice(0, 8)}.${extension}`,
    storage_filename: `u.${extension}`,
    extension,
    mime_type:
      extension === 'pdf'
        ? 'application/pdf'
        : extension === 'docx'
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'text/plain',
    file_size: 1000,
    content_hash: 'a'.repeat(64),
    storage_path: `${userId}/${id}/u.${extension}`,
    status: options.status ?? 'ready',
    page_count: options.pageCount ?? (extension === 'pdf' ? 5 : null),
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
  };
  fakeDb.documents.push(row);
  return row;
}

interface SeedChunkOptions {
  chunkIndex?: number;
  content?: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  heading?: string | null;
  sectionPath?: string | null;
  paragraphStart?: number | null;
  paragraphEnd?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
  embedding?: number[] | null;
}

function seedChunk(document: { id: string; user_id: string }, options: SeedChunkOptions = {}) {
  const content = options.content ?? 'Skills: Python, SQL and data visualization.';
  const row = {
    id: randomUUID(),
    document_id: document.id,
    user_id: document.user_id,
    chunk_index: options.chunkIndex ?? 0,
    content,
    embedding:
      options.embedding === undefined
        ? Array.from({ length: 1536 }, () => 0.5)
        : options.embedding,
    embedding_provider: 'gemini',
    embedding_model_version: 'gemini-embedding-2',
    embedding_dimensions: 1536,
    page_start: options.pageStart ?? null,
    page_end: options.pageEnd ?? null,
    heading: options.heading ?? null,
    section_path: options.sectionPath ?? null,
    paragraph_start: options.paragraphStart ?? 0,
    paragraph_end: options.paragraphEnd ?? 0,
    char_start: options.charStart ?? 0,
    char_end: options.charEnd ?? content.length,
    token_estimate: 10,
    created_at: new Date().toISOString(),
  };
  fakeDb.document_chunks.push(row);
  return row;
}

function search(body: Record<string, unknown>, token = TOKEN_A) {
  return request(app)
    .post('/api/documents/search')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

describe('M5 corrective patch 3 — document search API', () => {
  beforeEach(() => {
    resetFakeSupabase();
    resetRateLimits();
    embeddingState.fail = false;
    registerUser(TOKEN_A, USER_A, 'a@example.com');
    registerUser(TOKEN_B, USER_B, 'b@example.com');
  });

  it('returns owned chunks with real provenance and bounded previews', async () => {
    forceMatchSimilarity(0.9);
    const document = seedDocument({ filename: 'resume.pdf' });
    seedChunk(document, {
      pageStart: 4,
      pageEnd: 4,
      heading: 'Skills',
      sectionPath: '2 > Skills',
      paragraphStart: 2,
      paragraphEnd: 3,
      content: 'Skills: Python, SQL and data visualization. '.repeat(20),
    });

    const res = await search({ query: 'python skills' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.chunks).toHaveLength(1);
    const hit = res.body.chunks[0];
    expect(hit.document_id).toBe(document.id);
    expect(hit.filename).toBe('resume.pdf');
    expect(hit.page_start).toBe(4);
    expect(hit.page_end).toBe(4);
    expect(hit.heading).toBe('Skills');
    expect(hit.section_path).toBe('2 > Skills');
    expect(hit.paragraph_start).toBe(2);
    expect(hit.paragraph_end).toBe(3);
    expect(hit.chunk_id).toBeTruthy();
    expect(hit.preview.length).toBeLessThanOrEqual(401);
    expect(hit.preview).not.toContain('storage_path');
  });

  it('rejects invalid queries and out-of-range limits with Zod details', async () => {
    const invalidBodies: Array<Record<string, unknown>> = [
      {},
      { query: '' },
      { query: '   ' },
      { query: 'x'.repeat(2001) },
      { query: 'ok', max_results: 0 },
      { query: 'ok', max_results: 51 },
      { query: 'ok', threshold: 1.1 },
      { query: 'ok', document_ids: ['not-a-uuid'] },
      { query: 'ok', document_ids: Array.from({ length: 21 }, () => randomUUID()) },
    ];

    for (const body of invalidBodies) {
      const res = await search(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SEARCH_QUERY');
      expect(res.body.details).toBeDefined();
    }
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/documents/search')
      .send({ query: 'python' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('rejects cross-user document selection without leaking existence', async () => {
    const foreign = seedDocument({ userId: USER_B, filename: 'private.pdf' });
    seedChunk(foreign);

    const res = await search({ query: 'python', document_ids: [foreign.id] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DOCUMENT_NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain('private.pdf');
  });

  it('returns an empty result set when nothing passes the threshold', async () => {
    const document = seedDocument();
    seedChunk(document);

    const res = await search({ query: 'python', threshold: 0.99 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ chunks: [], count: 0 });
  });

  it('fails safely when the embedding provider is unavailable', async () => {
    const document = seedDocument();
    seedChunk(document);
    embeddingState.fail = true;

    const res = await search({ query: 'python' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DOCUMENT_SEARCH_EMBEDDING_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('simulated provider outage');
  });

  it('fails safely (not silently empty) when the retrieval RPC fails', async () => {
    const document = seedDocument();
    seedChunk(document);
    injectDatabaseFailure('match_document_chunks', 'rpc', 'simulated connection lost');

    const res = await search({ query: 'python', threshold: 0.1 });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DOCUMENT_SEARCH_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('connection lost');
  });

  it('excludes deleted and unprocessed documents', async () => {
    const ready = seedDocument({ filename: 'ready.pdf' });
    const readyChunk = seedChunk(ready, { content: 'ready content' });

    const deleted = seedDocument({ filename: 'deleted.pdf', status: 'deleted' });
    seedChunk(deleted, { content: 'deleted content' });

    const processing = seedDocument({ filename: 'processing.pdf', status: 'processing' });
    seedChunk(processing, { content: 'processing content' });

    const res = await search({ query: 'content', threshold: 0.1 });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.chunks[0].chunk_id).toBe(readyChunk.id);
    expect(res.body.chunks.map((c: { filename: string }) => c.filename)).not.toContain(
      'deleted.pdf',
    );
    expect(res.body.chunks.map((c: { filename: string }) => c.filename)).not.toContain(
      'processing.pdf',
    );
  });

  it('scopes explicitly selected ready documents', async () => {
    const first = seedDocument({ filename: 'first.pdf' });
    const firstChunk = seedChunk(first, { content: 'first content' });
    const second = seedDocument({ filename: 'second.pdf' });
    seedChunk(second, { content: 'second content' });

    const res = await search({
      query: 'content',
      document_ids: [first.id],
      threshold: 0.1,
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.chunks[0].chunk_id).toBe(firstChunk.id);
  });

  it('rejects explicitly selected unprocessed or deleted documents', async () => {
    const processing = seedDocument({ status: 'processing' });
    const processingRes = await search({
      query: 'python',
      document_ids: [processing.id],
    });
    expect(processingRes.status).toBe(409);
    expect(processingRes.body.code).toBe('DOCUMENT_NOT_SEARCHABLE');

    const deleted = seedDocument({ status: 'deleted' });
    const deletedRes = await search({
      query: 'python',
      document_ids: [deleted.id],
    });
    expect(deletedRes.status).toBe(404);
    expect(deletedRes.body.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('honours max_results', async () => {
    forceMatchSimilarity(0.9);
    const document = seedDocument();
    seedChunk(document, { chunkIndex: 0, content: 'chunk zero' });
    seedChunk(document, { chunkIndex: 1, content: 'chunk one' });
    seedChunk(document, { chunkIndex: 2, content: 'chunk two' });

    const res = await search({ query: 'chunk', max_results: 1 });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.chunks).toHaveLength(1);
  });
});

describe('M5 corrective patch 3 — citation viewer endpoints', () => {
  beforeEach(() => {
    resetFakeSupabase();
    resetRateLimits();
    registerUser(TOKEN_A, USER_A, 'a@example.com');
    registerUser(TOKEN_B, USER_B, 'b@example.com');
  });

  it('returns a short-lived view link for the owning user', async () => {
    const document = seedDocument({ filename: 'guide.pdf' });
    const res = await request(app)
      .get(`/api/documents/${document.id}/view`)
      .set(authA());

    expect(res.status).toBe(200);
    expect(res.body.extension).toBe('pdf');
    expect(res.body.page_count).toBe(5);
    expect(res.body.expires_in).toBe(120);
    expect(res.body.url).toContain('https://fake.local/');
    expect(res.body.url).toContain('expires=120');
    expect(res.body.url).not.toContain('storage_path');
  });

  it('does not resolve an unknown citation id', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      const res = await request(app)
        .get(`/api/documents/${id}/view`)
        .set(authA());
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('DOCUMENT_NOT_FOUND');
    }
  });

  it('does not resolve another user’s document', async () => {
    const foreign = seedDocument({ userId: USER_B });
    const res = await request(app)
      .get(`/api/documents/${foreign.id}/view`)
      .set(authA());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('does not resolve a deleted document through an old citation', async () => {
    const deleted = seedDocument({ status: 'deleted' });
    const view = await request(app)
      .get(`/api/documents/${deleted.id}/view`)
      .set(authA());
    expect(view.status).toBe(404);

    const content = await request(app)
      .get(`/api/documents/${deleted.id}/content`)
      .set(authA());
    expect(content.status).toBe(404);
  });

  it('rejects viewing a document that is still processing', async () => {
    const processing = seedDocument({ status: 'processing' });
    const res = await request(app)
      .get(`/api/documents/${processing.id}/view`)
      .set(authA());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOCUMENT_NOT_VIEWABLE');
  });

  it('streams private bytes only to the owner', async () => {
    const document = seedDocument({ filename: 'notes.txt', extension: 'txt', pageCount: null });
    seedStoredObject('documents', document.storage_path, Buffer.from('hello world'));

    const owner = await request(app)
      .get(`/api/documents/${document.id}/content`)
      .set(authA());
    expect(owner.status).toBe(200);
    expect(owner.text).toBe('hello world');
    expect(owner.headers['cache-control']).toContain('no-store');

    const foreign = await request(app)
      .get(`/api/documents/${document.id}/content`)
      .set('Authorization', `Bearer ${TOKEN_B}`);
    expect(foreign.status).toBe(404);
  });
});
