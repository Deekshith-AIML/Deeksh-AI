/**
 * scripts/verify-live-extraction.ts
 * ---------------------------------
 * Milestone 4.2 Task C — isolated LIVE extraction verification.
 *
 * Runs the REAL extraction scheduler (`startExtractionScheduler` →
 * `claimAndProcess`) against a local PostgREST + PostgreSQL + pgvector
 * stack, with the real Gemini extraction and embedding providers.
 *
 * It exercises, in order:
 *   1. normal extraction: pending → claimed → completed, memories stored
 *      with provenance and a real 1536-dim embedding;
 *   2. duplicate prevention: a second job for the same message does not
 *      create duplicate active memories;
 *   3. consent OFF at processing time: job completes with zero memories;
 *   4. permanent failure: a job with no source message is marked failed;
 *   5. stale-claim recovery: an orphaned `claimed` job returns to pending
 *      and is processed;
 *   6. credential guard: credential-shaped content is rejected;
 *   7. subsequent independent retrieval through `match_memories` (this
 *      also proves the service_role EXECUTE grant added in migration 0009).
 *
 * Requires a dedicated test user + messages/jobs seeded by the caller and
 * `VERIFY_USER_ID` / `VERIFY_MESSAGE_ID` in the environment.
 *
 * Not part of `npm test`. No secrets are printed.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createAdminClient } from '../src/services/supabase.service.js';
import { startExtractionScheduler } from '../src/workers/extraction.scheduler.js';
import * as memoryService from '../src/services/memory.service.js';
import { embed } from '../src/services/embedding.service.js';

const USER_ID = process.env.VERIFY_USER_ID ?? '';
const MESSAGE_ID = process.env.VERIFY_MESSAGE_ID ?? '';
const JOB_ID = process.env.VERIFY_JOB_ID ?? '';

if (!USER_ID || !MESSAGE_ID || !JOB_ID) {
  console.error('VERIFY_USER_ID, VERIFY_MESSAGE_ID and VERIFY_JOB_ID are required.');
  process.exit(2);
}

const client = createAdminClient();
const logs: string[] = [];
const logger = {
  info: (...a: unknown[]) => logs.push(`INFO ${a.map(String).join(' ')}`),
  warn: (...a: unknown[]) => logs.push(`WARN ${a.map(String).join(' ')}`),
  error: (...a: unknown[]) => logs.push(`ERROR ${a.map(String).join(' ')}`),
};

const results: Record<string, unknown> = {};

async function getJob(id: string) {
  const { data, error } = await client
    .from('memory_extraction_jobs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(`job read failed: ${error.message}`);
  return data as Record<string, unknown>;
}

async function waitForTerminal(id: string, timeoutMs = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await getJob(id);
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`job ${id} did not reach a terminal state within ${timeoutMs}ms`);
}

async function enqueue(messageId: string | null, status = 'pending', claimedAt?: string) {
  const id = randomUUID();
  const row: Record<string, unknown> = {
    id,
    user_id: USER_ID,
    message_id: messageId,
    status,
  };
  if (claimedAt) {
    row.claimed_at = claimedAt;
    row.attempts = 1;
  }
  const { error } = await client.from('memory_extraction_jobs').insert(row);
  if (error) throw new Error(`job insert failed: ${error.message}`);
  return id;
}

async function activeMemoryCount() {
  const { count, error } = await client
    .from('memories')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', USER_ID)
    .eq('status', 'active');
  if (error) throw new Error(`memory count failed: ${error.message}`);
  return count ?? 0;
}

async function main() {
  // The scheduler drains immediately and polls every 1.5s.
  const handle = startExtractionScheduler({
    client,
    intervalMs: 1500,
    runOnStart: true,
    logger,
  });

  try {
    // ---- 1. Normal extraction -------------------------------------------
    const job1 = await waitForTerminal(JOB_ID);
    const memoryIds1 = Array.isArray(job1.result_memory_ids) ? job1.result_memory_ids : [];
    const { data: memories1, error: memErr } = await client
      .from('memories')
      .select('id, content, category, confidence, status, source_message_id, source_evidence, embedding_provider, embedding_model_version, embedding_dimensions')
      .eq('user_id', USER_ID)
      .order('created_at', { ascending: true });
    if (memErr) throw new Error(`memory read failed: ${memErr.message}`);
    results.normalExtraction = {
      job: {
        status: job1.status,
        attempts: job1.attempts,
        result_memory_ids: memoryIds1,
        error_message: job1.error_message ?? null,
      },
      memories: memories1 ?? [],
    };

    // ---- 2. Duplicate prevention ----------------------------------------
    const countBeforeDuplicate = await activeMemoryCount();
    const duplicateJobId = await enqueue(MESSAGE_ID);
    const duplicateJob = await waitForTerminal(duplicateJobId);
    const countAfterDuplicate = await activeMemoryCount();
    results.duplicatePrevention = {
      status: duplicateJob.status,
      result_memory_ids: duplicateJob.result_memory_ids ?? [],
      activeMemoriesBefore: countBeforeDuplicate,
      activeMemoriesAfter: countAfterDuplicate,
      duplicateRowsCreated: Math.max(0, countAfterDuplicate - countBeforeDuplicate),
    };

    // ---- 3. Consent OFF at processing time ------------------------------
    await client
      .from('memory_settings')
      .update({ automatic_memory_extraction: false })
      .eq('user_id', USER_ID);
    const consentJobId = await enqueue(MESSAGE_ID);
    const consentJob = await waitForTerminal(consentJobId);
    results.consentOff = {
      status: consentJob.status,
      result_memory_ids: consentJob.result_memory_ids ?? [],
    };
    await client
      .from('memory_settings')
      .update({ automatic_memory_extraction: true })
      .eq('user_id', USER_ID);

    // ---- 4. Permanent failure: no source message ------------------------
    const failureJobId = await enqueue(null);
    const failureJob = await waitForTerminal(failureJobId);
    results.permanentFailure = {
      status: failureJob.status,
      error_message: failureJob.error_message ?? null,
      failed_at: failureJob.failed_at ?? null,
    };

    // ---- 5. Stale claim recovery ----------------------------------------
    const staleJobId = await enqueue(MESSAGE_ID, 'claimed', new Date(Date.now() - 10 * 60_000).toISOString());
    const staleJob = await waitForTerminal(staleJobId);
    results.staleRecovery = {
      status: staleJob.status,
      attempts: staleJob.attempts,
      result_memory_ids: staleJob.result_memory_ids ?? [],
    };

    // ---- 6. Credential guard (live service call) ------------------------
    let credentialError: string | null = null;
    try {
      await memoryService.createMemory(client, USER_ID, {
        content: 'My password is SuperSecret123! and my API key is sk-live-abcdef123456',
        category: 'other',
        confidence: 'high',
      });
    } catch (err) {
      credentialError = err instanceof Error ? `${(err as { code?: string }).code ?? err.name}: ${err.message}` : String(err);
    }
    results.credentialGuard = { rejected: credentialError !== null, error: credentialError };

    // ---- 7. Subsequent independent retrieval ----------------------------
    const queryEmbedding = await embed('What career goal and tools did I mention?', { role: 'query' });
    const retrieval = await memoryService.retrieveMemories(client, USER_ID, queryEmbedding, {
      threshold: 0.4,
      maxResults: 5,
      queryText: 'career goal data analyst Python SQL',
    });
    results.subsequentRetrieval = {
      count: retrieval.count,
      ids: retrieval.memories.map((m) => m.id),
      contents: retrieval.memories.map((m) => m.content),
    };
  } finally {
    await handle.stop();
  }

  console.log(JSON.stringify({ logs, results }, null, 2));
  const ok =
    (results.normalExtraction as any)?.job?.status === 'completed' &&
    (results.duplicatePrevention as any)?.duplicateRowsCreated === 0 &&
    (results.consentOff as any)?.status === 'completed' &&
    (results.consentOff as any)?.result_memory_ids?.length === 0 &&
    (results.permanentFailure as any)?.status === 'failed' &&
    (results.staleRecovery as any)?.status === 'completed' &&
    (results.credentialGuard as any)?.rejected === true;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify-live-extraction] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
