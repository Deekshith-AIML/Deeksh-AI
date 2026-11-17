/**
 * M5 Corrective Patch 4 — document worker reliability
 * ---------------------------------------------------
 * Exercises the durable document-processing worker end-to-end against the
 * in-memory Supabase double + fake object storage:
 *
 *  - successful processing
 *  - atomic claiming / concurrent claim safety
 *  - idempotent reprocessing (duplicate delivery)
 *  - stale-claim recovery and exhausted-claim failure
 *  - transient retry, retry exhaustion, storage failure
 *  - embedding-provider failure and partial chunk-insertion failure
 *  - database failure during processing
 *  - deleted-document exclusion and mismatched-owner rejection
 *  - a document is never marked `ready` without persisted chunks
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { processDocumentJobs, sweepDeletingDocuments } from '../src/workers/document.worker.js';
import {
  resetFakeSupabase,
  registerUser,
  fakeDb,
  fakeCreateUserScopedClient,
  seedStoredObject,
  injectStorageFailure,
  injectDatabaseFailure,
} from './helpers/fakeSupabase.js';
import type { FakeDocument, FakeDocumentJob } from './helpers/fakeSupabase.js';

// Controllable embedding-provider failure without breaking the mock path.
const embeddingState = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/services/embedding.service.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../src/services/embedding.service.js')
  >();
  return {
    ...actual,
    embed: async (
      text: string,
      opts?: { role?: 'query' | 'document'; mock?: boolean; provider?: 'gemini' | 'ollama' },
    ) => {
      if (embeddingState.fail) throw new Error('simulated embedding failure');
      return actual.embed(text, opts);
    },
  };
});

const USER = 'user-1';
const TOKEN = 'token-a';
const BUCKET = 'documents';

const TXT = [
  'Paragraph one is about Python, SQL and data analysis.',
  '',
  'Paragraph two covers data visualization and reporting.',
  '',
  'Paragraph three lists internships, projects and skills.',
].join('\n');

function nowIso(): string {
  return new Date().toISOString();
}

function seedDocument(overrides: Partial<FakeDocument> = {}): FakeDocument {
  const id = overrides.id ?? randomUUID();
  const row: FakeDocument = {
    id,
    user_id: USER,
    original_filename: 'notes.txt',
    storage_filename: 'u.txt',
    extension: 'txt',
    mime_type: 'text/plain',
    file_size: TXT.length,
    content_hash: randomUUID().replace(/-/g, ''),
    storage_path: `${USER}/${id}/u.txt`,
    status: 'processing',
    page_count: null,
    text_char_count: null,
    chunk_count: 0,
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
  seedStoredObject(BUCKET, row.storage_path, Buffer.from(TXT, 'utf8'), 'text/plain');
  return row;
}

function seedJob(document: FakeDocument, overrides: Partial<FakeDocumentJob> = {}): FakeDocumentJob {
  const row: FakeDocumentJob = {
    id: randomUUID(),
    document_id: document.id,
    user_id: document.user_id,
    status: 'claimed',
    attempts: 1,
    max_attempts: 3,
    claimed_at: nowIso(),
    last_attempt_at: null,
    next_attempt_at: nowIso(),
    failed_at: null,
    error_message: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
  fakeDb.document_processing_jobs.push(row);
  return row;
}

function findDoc(id: string): FakeDocument {
  const row = fakeDb.documents.find((d) => d.id === id);
  if (!row) throw new Error(`document ${id} missing`);
  return row;
}

function findJob(id: string): FakeDocumentJob {
  const row = fakeDb.document_processing_jobs.find((j) => j.id === id);
  if (!row) throw new Error(`job ${id} missing`);
  return row;
}

/** The fake client is structurally typed as `never`; worker jobs are rows. */
function jobRecord(job: FakeDocumentJob): Record<string, unknown> {
  return job as unknown as Record<string, unknown>;
}

interface RpcCapable {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

function rpcOf(client: unknown): RpcCapable {
  return client as RpcCapable;
}

describe('M5 Corrective Patch 4 — document worker reliability', () => {
  beforeEach(() => {
    resetFakeSupabase();
    embeddingState.fail = false;
    registerUser(TOKEN, USER, 'u@example.com');
  });

  it('processes a job to ready and persists chunks', async () => {
    const doc = seedDocument();
    const job = seedJob(doc);
    const client = fakeCreateUserScopedClient(TOKEN);

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 1, failed: 0 });
    const updated = findDoc(doc.id);
    expect(updated.status).toBe('ready');
    expect(updated.chunk_count).toBeGreaterThan(0);
    expect(updated.error_message).toBeNull();
    expect(fakeDb.document_chunks).toHaveLength(updated.chunk_count);
    expect(fakeDb.document_chunks.every((c) => c.embedding !== null)).toBe(true);
    expect(findJob(job.id).status).toBe('completed');
  });

  it('atomically claims a job once under concurrent claims', async () => {
    const doc = seedDocument({ status: 'pending' });
    const job = seedJob(doc, { status: 'pending', attempts: 0, claimed_at: null });
    const client = fakeCreateUserScopedClient(TOKEN);

    const [first, second] = await Promise.all([
      rpcOf(client).rpc('claim_document_processing_jobs', { p_limit: 5 }),
      rpcOf(client).rpc('claim_document_processing_jobs', { p_limit: 5 }),
    ]);

    const claimed = [
      ...(Array.isArray(first.data) ? first.data : []),
      ...(Array.isArray(second.data) ? second.data : []),
    ];
    expect(claimed).toHaveLength(1);
    expect(findJob(job.id).status).toBe('claimed');
    expect(findJob(job.id).attempts).toBe(1);
  });

  it('is idempotent when the same job is delivered twice', async () => {
    const doc = seedDocument();
    const job = seedJob(doc);
    const client = fakeCreateUserScopedClient(TOKEN);

    await processDocumentJobs({ client }, [jobRecord(job)]);
    const firstCount = fakeDb.document_chunks.length;
    expect(firstCount).toBeGreaterThan(0);

    await processDocumentJobs({ client }, [jobRecord(job)]);
    expect(fakeDb.document_chunks).toHaveLength(firstCount);
    expect(findDoc(doc.id).chunk_count).toBe(firstCount);
  });

  it('recovers a stale claim and processes it after restart', async () => {
    const doc = seedDocument();
    const job = seedJob(doc, {
      status: 'claimed',
      attempts: 1,
      claimed_at: new Date(Date.now() - 10_000).toISOString(),
    });
    const client = fakeCreateUserScopedClient(TOKEN);

    const recovered = await rpcOf(client).rpc('recover_stale_document_jobs', { p_stale_seconds: 1 });
    expect(recovered.data).toBe(1);
    expect(findJob(job.id).status).toBe('pending');
    expect(findJob(job.id).claimed_at).toBeNull();

    const claimed = await rpcOf(client).rpc('claim_document_processing_jobs', { p_limit: 5 });
    const jobs = Array.isArray(claimed.data) ? claimed.data : [];
    expect(jobs).toHaveLength(1);

    await processDocumentJobs({ client }, jobs as Array<Record<string, unknown>>);
    expect(findDoc(doc.id).status).toBe('ready');
  });

  it('fails a stale claim once retries are exhausted', async () => {
    const doc = seedDocument();
    const job = seedJob(doc, {
      status: 'claimed',
      attempts: 3,
      max_attempts: 3,
      claimed_at: new Date(Date.now() - 10_000).toISOString(),
    });
    const client = fakeCreateUserScopedClient(TOKEN);

    await rpcOf(client).rpc('recover_stale_document_jobs', { p_stale_seconds: 1 });

    expect(findJob(job.id).status).toBe('failed');
    expect(findJob(job.id).error_message).toBe('STALE_JOB_ATTEMPTS_EXHAUSTED');
  });

  it('retries after a transient storage retrieval failure', async () => {
    const doc = seedDocument();
    const job = seedJob(doc, { attempts: 1, max_attempts: 3 });
    const client = fakeCreateUserScopedClient(TOKEN);
    injectStorageFailure('download', 'simulated storage failure');

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 0, failed: 1 });
    const updatedJob = findJob(job.id);
    expect(updatedJob.status).toBe('pending');
    expect(updatedJob.error_message).toContain('simulated storage failure');
    expect(findDoc(doc.id).status).toBe('pending');
    expect(fakeDb.document_chunks).toHaveLength(0);
  });

  it('marks the job failed once retries are exhausted', async () => {
    const doc = seedDocument();
    const job = seedJob(doc, { attempts: 3, max_attempts: 3 });
    const client = fakeCreateUserScopedClient(TOKEN);
    injectStorageFailure('download', 'still unavailable');

    await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(findJob(job.id).status).toBe('failed');
    expect(findJob(job.id).failed_at).toBeTruthy();
    expect(findDoc(doc.id).status).toBe('failed');
    expect(fakeDb.document_chunks).toHaveLength(0);
  });

  it('retries when the embedding provider fails', async () => {
    const doc = seedDocument();
    const job = seedJob(doc, { attempts: 1, max_attempts: 3 });
    const client = fakeCreateUserScopedClient(TOKEN);
    embeddingState.fail = true;

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(findJob(job.id).status).toBe('pending');
    expect(findJob(job.id).error_message).toContain('simulated embedding failure');
    expect(findDoc(doc.id).status).not.toBe('ready');
    expect(fakeDb.document_chunks).toHaveLength(0);
  });

  it('never marks ready when chunk insertion fails part-way', async () => {
    const doc = seedDocument();
    const job = seedJob(doc, { attempts: 1, max_attempts: 3 });
    const client = fakeCreateUserScopedClient(TOKEN);
    injectDatabaseFailure('document_chunks', 'insert');

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(findDoc(doc.id).status).not.toBe('ready');
    expect(findJob(job.id).status).toBe('pending');
    expect(fakeDb.document_chunks).toHaveLength(0);
  });

  it('handles a database failure while loading the document', async () => {
    const doc = seedDocument();
    const job = seedJob(doc, { attempts: 3, max_attempts: 3 });
    const client = fakeCreateUserScopedClient(TOKEN);
    injectDatabaseFailure('documents', 'select');

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(findJob(job.id).status).toBe('failed');
    expect(findDoc(doc.id).status).toBe('failed');
  });

  it('skips a document that is already deleted and completes the job', async () => {
    const doc = seedDocument({ status: 'deleted' });
    const job = seedJob(doc);
    const client = fakeCreateUserScopedClient(TOKEN);

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(findJob(job.id).status).toBe('completed');
    expect(findJob(job.id).error_message).toBe('SKIPPED_DELETED');
    expect(findDoc(doc.id).status).toBe('deleted');
    expect(fakeDb.document_chunks).toHaveLength(0);
  });

  it('rejects a job whose user does not own the document', async () => {
    const doc = seedDocument({ user_id: USER });
    // Forged/mismatched job owned by another user.
    const job = seedJob(doc, { user_id: 'user-2', attempts: 3, max_attempts: 3 });
    const client = fakeCreateUserScopedClient(TOKEN);

    const result = await processDocumentJobs({ client }, [jobRecord(job)]);

    expect(result).toEqual({ processed: 0, failed: 1 });
    expect(findJob(job.id).status).toBe('failed');
    expect(findDoc(doc.id).status).not.toBe('ready');
    expect(fakeDb.document_chunks).toHaveLength(0);
  });

  it('sweeps a stuck deleting document to deleted', async () => {
    const doc = seedDocument({ status: 'deleting' });
    const client = fakeCreateUserScopedClient(TOKEN);

    const swept = await sweepDeletingDocuments({ client });

    expect(swept).toBe(1);
    expect(findDoc(doc.id).status).toBe('deleted');
    expect(findDoc(doc.id).chunk_count).toBe(0);
  });
});
