/**
 * workers/extraction.worker.ts
 * -----------------------------
 * Durable memory extraction outbox (Milestone 4 — instruction 9),
 * reworked for Milestone 4.1 Task C (structured extraction).
 *
 * Uses the PostgreSQL-backed job table (`memory_extraction_jobs`) with an
 * ATOMIC claim through the `claim_memory_extraction_jobs()` SQL function
 * (FOR UPDATE SKIP LOCKED) — two concurrent workers can never claim the
 * same job, and interrupted ("stale") claims are recovered automatically.
 *
 * Per-job pipeline (order matters):
 *   1. resolve the source message (permanent failure when missing),
 *   2. CONSENT re-check — `automatic_memory_extraction` must be ON at
 *      processing time (opting out after enqueue still prevents work),
 *   3. USER-AUTHORED ONLY — `role === 'user'`; assistant turns complete
 *      with zero memories (never extracted),
 *   4. structured extraction (Zod-validated, bounded LLM attempts),
 *   5. store high-confidence facts as `active`, medium as `needs_review`;
 *      credentials/low-confidence were already dropped by the service,
 *   6. complete the job with the created memory ids (or [] on no-op).
 *
 * - Prevents duplicate processing (atomic claim).
 * - Retries transient failures (job returns to `pending` until attempts
 *   reach MAX_ATTEMPTS, then flips to `failed` with the error recorded).
 * - Never blocks normal chat: this runs in the background; chat only
 *   enqueues jobs (consent-gated) and responds immediately.
 * - No Redis required — PostgreSQL is the durable outbox.
 */

import * as MemoryService from '../services/memory.service.js';
import { extractFacts } from '../services/extraction.service.js';

const MAX_ATTEMPTS = 3;

/** Shape of a row returned by `claim_memory_extraction_jobs()`. */
interface ClaimedJob {
  id: string;
  user_id: string;
  message_id: string | null;
  status: string;
  attempts: number;
  [key: string]: unknown;
}

/**
 * Claim up to `limit` pending jobs atomically and process each one.
 * Returns how many were completed and how many failed permanently.
 *
 * @param client Service-role Supabase client (worker context — the claim
 *               function is granted to `service_role` only).
 */
export async function claimAndProcess(
  client: any,
  userId?: string,
): Promise<{ processed: number; failed: number }> {
  // Atomic claim: single SQL statement with FOR UPDATE SKIP LOCKED.
  // Also recovers stale claims (claimed > 5 min ago) before claiming.
  let jobs: ClaimedJob[] = [];
  try {
    const { data, error } = await client.rpc('claim_memory_extraction_jobs', { p_limit: 5 });
    if (error) {
      console.warn('[extraction.claim] RPC failed (is 0005 applied?):', error.message);
      return { processed: 0, failed: 0 };
    }
    jobs = Array.isArray(data) ? (data as ClaimedJob[]) : [];
  } catch (err) {
    console.warn('[extraction.claim] claim failed:', err instanceof Error ? err.message : err);
    return { processed: 0, failed: 0 };
  }

  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      // 1. Resolve the source user-authored message (provenance).
      const messageId = job.message_id;
      if (!messageId) {
        await markFailed(client, job.id, 'No source message.');
        failed++;
        continue;
      }

      const { data: msgData } = await client
        .from('messages')
        .select('content, role')
        .eq('id', messageId)
        .single();
      if (!msgData || !msgData.content) {
        await markFailed(client, job.id, 'Message not found.');
        failed++;
        continue;
      }

      const content = String(msgData.content).trim();
      if (content.length < 3) {
        // Nothing extractable — not a failure.
        await completeWith(client, job.id, []);
        processed++;
        continue;
      }

      // 2. Ownership: job.user_id is authoritative; the optional userId
      //    argument must never disagree with it.
      const userIdActual = typeof job.user_id === 'string' && job.user_id ? job.user_id : userId;
      if (!userIdActual) {
        await markFailed(client, job.id, 'No user id on job.');
        failed++;
        continue;
      }

      // 3. CONSENT re-check at processing time (defense in depth): with
      //    automatic extraction OFF — the default — the job completes with
      //    zero memories and the message is never sent to the LLM.
      const settings = (await MemoryService.getMemorySettings(client, userIdActual)) as
        | { automatic_memory_extraction?: boolean }
        | null;
      if (!settings || settings.automatic_memory_extraction !== true) {
        await completeWith(client, job.id, []);
        processed++;
        continue;
      }

      // 4. USER-AUTHORED ONLY: assistant/system turns are never extracted.
      if (String(msgData.role ?? '') !== 'user') {
        await completeWith(client, job.id, []);
        processed++;
        continue;
      }

      // 5. Structured extraction (Task C): Zod-validated LLM output with
      //    bounded attempts; credential/low-confidence facts are dropped
      //    inside the service and never reach storage.
      const candidates = await extractFacts(content);

      // 6. Store candidates with confidence-driven status:
      //    high → active (auto-stored, consent already verified above),
      //    medium → needs_review (user confirms in the dashboard).
      const memoryIds: string[] = [];
      for (const candidate of candidates) {
        try {
          const stored = await MemoryService.createMemory(client, userIdActual, {
            content: candidate.content,
            category: candidate.category,
            sourceMessageId: messageId,
            evidence: candidate.evidence ?? undefined,
            confidence: candidate.confidence,
            sensitivity: candidate.sensitivity,
            status: candidate.confidence === 'high' ? 'active' : 'needs_review',
          });
          memoryIds.push(stored.memory.id);
        } catch (err) {
          // Last-line credential guard (service-level auto-guard) — skip
          // the fact rather than failing the whole job.
          if (err instanceof MemoryService.MemoryServiceError && err.code === 'CREDENTIAL_BLOCKED') {
            console.warn('[extraction] credential-shaped fact skipped — never stored.');
            continue;
          }
          throw err; // real storage failure → job-level retry handling below
        }
      }

      await completeWith(client, job.id, memoryIds);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const attempts = Number(job.attempts ?? 0);
      if (attempts >= MAX_ATTEMPTS) {
        // Exhausted retries → permanent failure, error recorded for ops.
        await markFailed(client, job.id, msg);
        failed++;
      } else {
        // Transient → return to pending; the next tick retries it.
        await client
          .from('memory_extraction_jobs')
          .update({ status: 'pending', claimed_at: null, error_message: msg })
          .eq('id', job.id);
        processed++;
      }
    }
  }

  return { processed, failed };
}

/** Record a permanent failure on a job. */
async function markFailed(client: any, jobId: string, message: string): Promise<void> {
  await client
    .from('memory_extraction_jobs')
    .update({ status: 'failed', failed_at: new Date().toISOString(), error_message: message })
    .eq('id', jobId);
}

/** Complete a job with the ids of the memories it produced ([] on no-op). */
async function completeWith(client: any, jobId: string, memoryIds: string[]): Promise<void> {
  await client
    .from('memory_extraction_jobs')
    .update({ status: 'completed', result_memory_ids: memoryIds })
    .eq('id', jobId);
}

/**
 * Recover jobs stuck in `claimed` for longer than `staleSeconds`
 * (e.g. the worker crashed mid-processing) back to `pending`.
 */
export async function recoverStaleClaims(client: any, staleSeconds = 300): Promise<number> {
  try {
    const { data, error } = await client.rpc('recover_stale_extraction_jobs', {
      p_stale_seconds: staleSeconds,
    });
    if (error) {
      console.warn('[extraction.recover] RPC failed:', error.message);
      return 0;
    }
    return Number(data ?? 0);
  } catch (err) {
    console.warn('[extraction.recover] failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}
