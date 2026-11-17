/**
 * scripts/evaluate-document-rag.ts
 * --------------------------------
 * Milestone 5 Phase 12 — reproducible document-RAG evaluation.
 *
 * WHAT THIS SCRIPT DOES
 * ---------------------
 *   `--self-check`
 *       Validates the synthetic corpus and query ground truth offline
 *       (no network, no database). Suitable for CI.
 *
 *   default
 *       If a live development/staging Supabase environment is configured
 *       AND the operator explicitly opts in (`EVAL_CONFIRM=yes`), it:
 *         1. generates the 20-document synthetic corpus,
 *         2. uploads it for one dedicated synthetic user,
 *         3. drains the real durable worker,
 *         4. retrieves with the production `searchDocumentChunks` service and
 *            real Gemini embeddings,
 *         5. answers selected questions through the production `chat()`
 *            orchestration, validates citations and refusal behaviour,
 *         6. writes a JSON report,
 *         7. deletes only the documents it created.
 *       If configuration is missing it writes an explicit BLOCKED report and
 *       exits 0. It NEVER fabricates scores.
 *
 * REQUIRED LIVE ENVIRONMENT (values are never printed)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GEMINI_API_KEY
 *   EVAL_USER_ID            dedicated synthetic auth user
 *   EVAL_CONFIRM=yes        explicit write opt-in
 *
 * OPTIONAL
 *   EVAL_USER_EMAIL_PREFIX  default `eval-rag-`
 *   EVAL_ANSWER_LIMIT       default 22; `all` for every query
 *   EVAL_CREATE_PEER=no     skip the cross-user peer check
 *   EVAL_OUTPUT_DIR         default `evaluation-results`
 *   EVAL_WORKER_TIMEOUT_MS  default 180000
 *
 * Not part of `npm test`. No production user/document is ever touched.
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  CORPUS_USER_MARKER,
  corpusSummary,
  generateCorpus,
  normalizeForMatch,
  type GeneratedDocument,
} from './evaluation/document-rag-corpus.js';
import {
  QUERIES,
  queryCategoryCounts,
  type EvalQuery,
  type QueryCategory,
} from './evaluation/document-rag-queries.js';
import {
  aggregateRetrieval,
  answerContainsAll,
  citationAvailability,
  checkCitationIntegrity,
  emptyQueryRejectionRate,
  evaluateAnswerOutcome,
  insufficientEvidenceRate,
  scoreQuery,
  summarizeLatencies,
  unsupportedAnswerRate,
  type AnswerOutcome,
  type ScoredQueryResult,
} from './evaluation/document-rag-metrics.js';
import { checkDatasetWithBytes } from './evaluation/document-rag-self-check.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';
import { searchDocumentChunks } from '../src/services/documents/retrieval.service.js';
import {
  createDocument,
  deleteDocument,
  getDocumentViewLink,
  getOwnedRow,
} from '../src/services/documents/document.service.js';
import { createStorageProvider } from '../src/services/storage/index.js';
import { processDocumentJobs, sweepDeletingDocuments } from '../src/workers/document.worker.js';
import { embed, getActiveSpace, resolveEmbeddingConfig } from '../src/services/embedding.service.js';
import { validateCitations, buildSourceMap } from '../src/services/documents/citation.service.js';
import type { DocumentSource } from '../../shared/types.js';

const DEFAULT_OUTPUT_DIR = 'evaluation-results';
const DEFAULT_ANSWER_LIMIT = 22;
const DEFAULT_WORKER_TIMEOUT_MS = 180_000;

interface LiveConfig {
  url: string;
  serviceRoleKey: string;
  userId: string;
  confirm: boolean;
  userEmailPrefix: string;
  answerLimit: number | 'all';
  createPeer: boolean;
  outputDir: string;
  workerTimeoutMs: number;
}

interface ChunkRow {
  id: string;
  document_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  section_path: string | null;
}

interface SeedRecord {
  key: string;
  title: string;
  format: string;
  filename: string;
  documentId: string;
  status: string;
  errorMessage: string | null;
  chunkCount: number;
}

interface BlockedStep {
  step: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// CLI / environment
// ---------------------------------------------------------------------------

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? '';
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function envValue(name: string): string {
  return (process.env[name] ?? '').trim();
}

function answerLimitFromEnv(): number | 'all' {
  const raw = envValue('EVAL_ANSWER_LIMIT').toLowerCase();
  if (raw === 'all') return 'all';
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return DEFAULT_ANSWER_LIMIT;
}

function readLiveConfig(): LiveConfig | null {
  const url = envValue('SUPABASE_URL');
  const serviceRoleKey = envValue('SUPABASE_SERVICE_ROLE_KEY');
  const userId = envValue('EVAL_USER_ID');
  if (!url || !serviceRoleKey || !userId) return null;
  return {
    url,
    serviceRoleKey,
    userId,
    confirm: envValue('EVAL_CONFIRM').toLowerCase() === 'yes',
    userEmailPrefix: envValue('EVAL_USER_EMAIL_PREFIX') || 'eval-rag-',
    answerLimit: answerLimitFromEnv(),
    createPeer: envValue('EVAL_CREATE_PEER').toLowerCase() !== 'no',
    outputDir: envValue('EVAL_OUTPUT_DIR') || DEFAULT_OUTPUT_DIR,
    workerTimeoutMs:
      Number.parseInt(envValue('EVAL_WORKER_TIMEOUT_MS'), 10) || DEFAULT_WORKER_TIMEOUT_MS,
  };
}

function missingLiveConfig(): string[] {
  const missing: string[] = [];
  if (!envValue('SUPABASE_URL')) missing.push('SUPABASE_URL');
  if (!envValue('SUPABASE_ANON_KEY')) missing.push('SUPABASE_ANON_KEY');
  if (!envValue('SUPABASE_SERVICE_ROLE_KEY')) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!envValue('GEMINI_API_KEY')) missing.push('GEMINI_API_KEY');
  if (!envValue('EVAL_USER_ID')) missing.push('EVAL_USER_ID');
  if (envValue('EVAL_CONFIRM').toLowerCase() !== 'yes') missing.push('EVAL_CONFIRM');
  return missing;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function isoNow(): string {
  return new Date().toISOString();
}

async function writeJson(outputDir: string, filename: string, value: unknown): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, filename);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return target;
}

function baseConfigReport() {
  const documentsConfig = getDocumentsConfig();
  let embeddingProvider = 'unknown';
  let embeddingModel = 'unknown';
  let embeddingDimension = 0;
  try {
    const active = getActiveSpace();
    embeddingProvider = active.provider;
    embeddingModel = active.model;
    embeddingDimension = active.dimension;
  } catch {
    const resolved = resolveEmbeddingConfig();
    embeddingProvider = resolved.provider;
    embeddingModel =
      resolved.provider === 'gemini' ? resolved.geminiModel : resolved.ollamaModel;
    embeddingDimension = resolved.provider === 'gemini' ? 1536 : 768;
  }

  return {
    embeddingProvider,
    embeddingModel,
    embeddingDimension,
    embeddingRole: 'query',
    retrievalThreshold: documentsConfig.retrievalThreshold,
    retrievalTopK: documentsConfig.retrievalTopK,
    chatTopK: documentsConfig.chatTopK,
    maxContextChars: documentsConfig.maxContextChars,
    chunkTargetTokens: documentsConfig.chunkTargetTokens,
    chunkOverlapTokens: documentsConfig.chunkOverlapTokens,
    maxChunksPerDocument: documentsConfig.maxChunksPerDocument,
    chatModelPrimary: envValue('GEMINI_MODEL') || 'gemini-3.8-flash (default)',
    chatModelFallback: envValue('OLLAMA_MODEL') || 'mistral:latest (default)',
    corpusDocuments: corpusSummary().documents,
    queries: QUERIES.length,
    categories: queryCategoryCounts(),
  };
}

function blockedReport(missing: string[], reasons: string[]) {
  const summary = corpusSummary();
  const steps: BlockedStep[] = [
    {
      step: 'Confirm live write access for the synthetic evaluation account',
      reason: missing.includes('EVAL_CONFIRM')
        ? 'EVAL_CONFIRM must be set to yes.'
        : 'Live writes were not confirmed.',
    },
    {
      step: 'Authenticate a dedicated synthetic test account',
      reason: missing.includes('EVAL_USER_ID')
        ? 'EVAL_USER_ID is not configured.'
        : 'Required Supabase credentials are missing.',
    },
    {
      step: 'Upload PDF, DOCX and TXT fixtures through createDocument()',
      reason: missing.includes('SUPABASE_SERVICE_ROLE_KEY')
        ? 'SUPABASE_SERVICE_ROLE_KEY is required for the isolated storage/DB writes.'
        : 'Live Supabase is not fully configured.',
    },
    {
      step: 'Drain the durable document worker (pending → processing → ready)',
      reason: missing.includes('SUPABASE_SERVICE_ROLE_KEY')
        ? 'The worker needs the service-role client (migration 0010 grants).'
        : 'Worker cannot run without a live database.',
    },
    {
      step: 'Verify extracted text, chunk persistence and 1536-dimensional embeddings',
      reason: 'Requires a live database with migration 0011 applied.',
    },
    {
      step: 'Run production semantic retrieval and compute P@5 / R@5 / MRR / latency',
      reason: 'Requires a live pgvector index and real Gemini embeddings.',
    },
    {
      step: 'Generate RAG answers with Gemini and evaluate Ollama fallback',
      reason: missing.includes('GEMINI_API_KEY')
        ? 'GEMINI_API_KEY is not configured.'
        : 'Live model calls are opt-in and require a configured provider.',
    },
    {
      step: 'Verify signed URLs, deletion and cross-user isolation',
      reason: 'Requires live Storage and RLS.',
    },
  ];

  return {
    generatedAt: isoNow(),
    status: 'blocked' as const,
    mode: 'live' as const,
    missingEnvironment: missing,
    reasons,
    dataset: {
      documents: summary.documents,
      formats: summary.formats,
      queries: QUERIES.length,
      categories: queryCategoryCounts(),
    },
    blockedSteps: steps,
    scores: null,
    note:
      'No retrieval, citation or answer-quality score is produced in blocked mode. ' +
      'Mock-based deterministic tests cover pipeline wiring only; they are not live RAG quality evidence.',
  };
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

async function runSelfCheck(outputDir: string): Promise<number> {
  const check = await checkDatasetWithBytes();
  const payload = {
    generatedAt: isoNow(),
    status: check.ok ? ('ok' as const) : ('failed' as const),
    mode: 'self-check' as const,
    stats: check.stats,
    errors: check.errors,
  };
  const target = await writeJson(outputDir, 'document-rag-self-check.json', payload);
  if (!check.ok) {
    console.error('Dataset self-check FAILED:');
    for (const error of check.errors) console.error(`- ${error}`);
    console.error(`Report: ${target}`);
    return 1;
  }
  console.log('Dataset self-check passed.');
  console.log(
    `Documents: ${check.stats.documents} (${JSON.stringify(check.stats.formats)}); ` +
      `queries: ${check.stats.queries} (${check.stats.scoredQueries} scored).`,
  );
  console.log(`Report: ${target}`);
  return 0;
}

// ---------------------------------------------------------------------------
// Live helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifySyntheticUser(
  admin: SupabaseClient,
  userId: string,
  emailPrefix: string,
): Promise<string> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data.user) {
    throw new Error(`EVAL_USER_ID does not resolve to an auth user (${error?.message ?? 'not found'}).`);
  }
  const email = data.user.email ?? '';
  if (!email.toLowerCase().startsWith(emailPrefix.toLowerCase())) {
    throw new Error(
      `Refusing to write: user email does not start with "${emailPrefix}". ` +
        'Set EVAL_USER_ID to a dedicated synthetic account or adjust EVAL_USER_EMAIL_PREFIX.',
    );
  }
  return email;
}

async function removePreviousEvalDocuments(
  admin: SupabaseClient,
  userId: string,
  storage: ReturnType<typeof createStorageProvider>,
  filenames: readonly string[],
): Promise<number> {
  const { data, error } = await admin
    .from('documents')
    .select('id,status,original_filename')
    .eq('user_id', userId)
    .in('original_filename', [...filenames]);
  if (error) throw new Error(`Could not list previous evaluation documents: ${error.message}`);

  let removed = 0;
  for (const row of data ?? []) {
    const id = String((row as { id: string }).id);
    try {
      await deleteDocument(admin, userId, id, storage);
      removed += 1;
    } catch {
      // The sweeper can recover a stuck deletion; continue with the rest.
    }
  }
  if (removed > 0) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const swept = await sweepDeletingDocuments({ client: admin });
      if (swept === 0) break;
      await sleep(250);
    }
  }
  return removed;
}

async function seedCorpus(
  admin: SupabaseClient,
  userId: string,
  storage: ReturnType<typeof createStorageProvider>,
  docs: readonly GeneratedDocument[],
): Promise<SeedRecord[]> {
  const records: SeedRecord[] = [];
  for (const doc of docs) {
    const created = await createDocument(
      admin,
      userId,
      { bytes: doc.bytes, originalFilename: doc.filename },
      storage,
    );
    records.push({
      key: doc.key,
      title: doc.title,
      format: doc.format,
      filename: doc.filename,
      documentId: created.id,
      status: created.status,
      errorMessage: created.error_message ?? null,
      chunkCount: created.chunk_count ?? 0,
    });
  }
  return records;
}

async function drainWorker(
  admin: SupabaseClient,
  documentIds: readonly string[],
  timeoutMs: number,
): Promise<Array<{ id: string; status: string; error_message: string | null }>> {
  const deadline = Date.now() + timeoutMs;
  const batchSize = Math.max(getDocumentsConfig().workerBatchSize, 1);

  while (Date.now() < deadline) {
    // Only process jobs that belong to the seeded documents. This deliberately
    // does NOT call `claim_document_processing_jobs()`, because that RPC claims
    // jobs across all users; an evaluation must never touch another user's
    // queued work.
    const jobQuery = await admin
      .from('document_processing_jobs')
      .select('id,document_id,user_id,attempts,max_attempts,status')
      .in('document_id', [...documentIds])
      .in('status', ['pending', 'claimed'])
      .order('created_at', { ascending: true })
      .limit(batchSize);
    if (jobQuery.error) {
      throw new Error(`Could not load evaluation jobs: ${jobQuery.error.message}`);
    }
    const ownJobs = (jobQuery.data ?? []) as Array<Record<string, unknown>>;
    if (ownJobs.length > 0) {
      await processDocumentJobs({ client: admin }, ownJobs);
      continue;
    }

    const { data, error } = await admin
      .from('documents')
      .select('id,status,error_message')
      .in('id', [...documentIds]);
    if (error) throw new Error(`Could not read document status: ${error.message}`);

    const rows = (data ?? []) as Array<{
      id: string;
      status: string;
      error_message: string | null;
    }>;
    const unfinished = rows.filter(
      (row) => row.status === 'pending' || row.status === 'processing' || row.status === 'uploaded',
    );
    if (unfinished.length === 0) return rows;
    await sleep(1000);
  }

  throw new Error(`Worker did not finish within ${timeoutMs}ms.`);
}

async function loadChunks(
  admin: SupabaseClient,
  userId: string,
  documentIds: readonly string[],
): Promise<ChunkRow[]> {
  const rows: ChunkRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from('document_chunks')
      .select(
        'id,document_id,user_id,chunk_index,content,page_start,page_end,heading,section_path',
      )
      .eq('user_id', userId)
      .in('document_id', [...documentIds])
      .order('document_id', { ascending: true })
      .order('chunk_index', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`Could not load chunks: ${error.message}`);
    const page = (data ?? []) as ChunkRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

/**
 * Resolve hand-authored anchors to persisted chunk ids. Resolution scans the
 * seeded corpus only; it never consults retrieval output. Overlap can place an
 * anchor in two adjacent chunks, so all matching chunks are included.
 */
function resolveExpectedChunkIds(
  query: EvalQuery,
  chunks: readonly ChunkRow[],
  docIdByKey: ReadonlyMap<string, string>,
): string[] {
  const allowedDocIds = new Set(
    query.expectedDocKeys.map((key) => docIdByKey.get(key)).filter((id): id is string => Boolean(id)),
  );
  const ids = new Set<string>();
  for (const anchor of query.expectedAnchors) {
    const matches = chunks.filter(
      (chunk) =>
        (allowedDocIds.size === 0 || allowedDocIds.has(chunk.document_id)) &&
        normalizeForMatch(chunk.content).includes(anchor),
    );
    if (matches.length === 0) {
      throw new Error(`Anchor "${anchor}" for ${query.id} did not resolve to any persisted chunk.`);
    }
    for (const match of matches) ids.add(match.id);
  }
  return Array.from(ids);
}

async function fetchDocument(
  admin: SupabaseClient,
  documentId: string,
): Promise<{ id: string; user_id: string } | null> {
  const { data } = await admin
    .from('documents')
    .select('id,user_id')
    .eq('id', documentId)
    .maybeSingle();
  return (data as { id: string; user_id: string } | null) ?? null;
}

async function fetchChunk(
  admin: SupabaseClient,
  chunkId: string,
): Promise<{
  id: string;
  document_id: string;
  page_start: number | null;
  heading: string | null;
} | null> {
  const { data } = await admin
    .from('document_chunks')
    .select('id,document_id,page_start,heading')
    .eq('id', chunkId)
    .maybeSingle();
  return (
    (data as {
      id: string;
      document_id: string;
      page_start: number | null;
      heading: string | null;
    } | null) ?? null
  );
}

function selectAnswerQueries(limit: number | 'all'): EvalQuery[] {
  if (limit === 'all') return [...QUERIES];
  // Always include the safety categories, then fill with the first scored
  // queries so the sample stays deterministic.
  const safety = QUERIES.filter(
    (query) =>
      query.category === 'unanswerable' ||
      query.category === 'irrelevant' ||
      query.category === 'prompt_injection',
  );
  const remaining = QUERIES.filter((query) => !safety.includes(query));
  const selected = [...safety, ...remaining.slice(0, Math.max(0, limit - safety.length))];
  return selected;
}

async function createPeerUser(
  admin: SupabaseClient,
  emailPrefix: string,
): Promise<{ id: string; email: string } | null> {
  const email = `${emailPrefix}peer-${Date.now()}@example.invalid`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: `Eval-${Date.now()}-${Math.random().toString(36).slice(2)}!`,
    email_confirm: true,
  });
  if (error || !data.user) return null;
  return { id: data.user.id, email };
}

// ---------------------------------------------------------------------------
// Live evaluation
// ---------------------------------------------------------------------------

async function runLive(config: LiveConfig): Promise<number> {
  const reportsDir = path.join(process.cwd(), config.outputDir);
  const admin = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const storage = createStorageProvider(admin);

  const createdDocumentIds: string[] = [];
  const startedAt = isoNow();
  let peerUserId: string | null = null;

  try {
    const email = await verifySyntheticUser(admin, config.userId, config.userEmailPrefix);
    const corpus = await generateCorpus();
    const filenames = corpus.map((doc) => doc.filename);

    const removed = await removePreviousEvalDocuments(admin, config.userId, storage, filenames);

    const seeds = await seedCorpus(admin, config.userId, storage, corpus);
    for (const seed of seeds) createdDocumentIds.push(seed.documentId);

    const statuses = await drainWorker(admin, createdDocumentIds, config.workerTimeoutMs);
    const statusById = new Map(statuses.map((row) => [row.id, row]));
    for (const seed of seeds) {
      const status = statusById.get(seed.documentId);
      seed.status = status?.status ?? 'unknown';
      seed.errorMessage = status?.error_message ?? null;
    }
    const notReady = seeds.filter((seed) => seed.status !== 'ready');
    if (notReady.length > 0) {
      throw new Error(
        `Documents did not reach ready: ${notReady
          .map((seed) => `${seed.key}=${seed.status}${seed.errorMessage ? `(${seed.errorMessage})` : ''}`)
          .join(', ')}`,
      );
    }

    const chunks = await loadChunks(admin, config.userId, createdDocumentIds);
    const docIdByKey = new Map(seeds.map((seed) => [seed.key, seed.documentId]));
    const docKeyById = new Map(seeds.map((seed) => [seed.documentId, seed.key]));

    // Every anchor must resolve before any metric is computed.
    const expectedIdsByQuery = new Map<string, string[]>();
    for (const query of QUERIES) {
      if (query.expectedAnchors.length === 0) {
        expectedIdsByQuery.set(query.id, []);
        continue;
      }
      expectedIdsByQuery.set(
        query.id,
        resolveExpectedChunkIds(query, chunks, docIdByKey),
      );
    }

    const documentsConfig = getDocumentsConfig();
    const scoredResults: ScoredQueryResult[] = [];
    const retrievalLatencies: number[] = [];
    const retrievalByQuery: Array<{
      id: string;
      category: QueryCategory;
      latencyMs: number;
      retrieved: Array<{
        chunkId: string;
        documentId: string;
        documentKey: string | null;
        page: number | null;
        heading: string | null;
        similarity: number;
      }>;
    }> = [];
    const provenanceFailures: string[] = [];
    const pageExactChecks: Array<{ id: string; expectedPage: number; exact: boolean }> = [];

    for (const query of QUERIES) {
      const embedding = await embed(query.query, { role: 'query' });
      const started = performance.now();
      const hits = await searchDocumentChunks(admin, config.userId, embedding, {
        threshold: documentsConfig.retrievalThreshold,
        maxResults: 5,
        throwOnError: true,
      });
      const latencyMs = performance.now() - started;
      retrievalLatencies.push(latencyMs);

      const retrievedIds = hits.map((hit) => hit.chunkId);
      retrievalByQuery.push({
        id: query.id,
        category: query.category,
        latencyMs,
        retrieved: hits.map((hit) => ({
          chunkId: hit.chunkId,
          documentId: hit.documentId,
          documentKey: docKeyById.get(hit.documentId) ?? null,
          page: hit.pageStart,
          heading: hit.heading,
          similarity: hit.similarity,
        })),
      });

      if (query.scored) {
        const expectedIds = expectedIdsByQuery.get(query.id) ?? [];
        scoredResults.push(scoreQuery(query, retrievedIds, expectedIds, 5));
      }

      if (query.expectedPage !== undefined || query.expectedHeading !== undefined) {
        const expectedSet = new Set(expectedIdsByQuery.get(query.id) ?? []);
        const matched = hits.filter((hit) => expectedSet.has(hit.chunkId));
        const pageContained =
          query.expectedPage === undefined ||
          matched.some(
            (hit) =>
              hit.pageStart !== null &&
              hit.pageEnd !== null &&
              query.expectedPage !== undefined &&
              query.expectedPage >= hit.pageStart &&
              query.expectedPage <= hit.pageEnd,
          );
        const pageExact =
          query.expectedPage === undefined ||
          matched.some((hit) => hit.pageStart === query.expectedPage);
        const headingOk =
          query.expectedHeading === undefined ||
          matched.some((hit) => hit.heading === query.expectedHeading);
        if (query.expectedPage !== undefined) {
          pageExactChecks.push({
            id: query.id,
            expectedPage: query.expectedPage,
            exact: pageExact,
          });
        }
        if (!pageContained || !headingOk) {
          provenanceFailures.push(
            `${query.id}: pageContained=${String(pageContained)} heading=${String(headingOk)}`,
          );
        }
      }
    }

    const retrieval = aggregateRetrieval(scoredResults);
    const latency = summarizeLatencies(retrievalLatencies);

    // -----------------------------------------------------------------------
    // Answer / citation evaluation (opt-in model calls)
    // -----------------------------------------------------------------------
    const { chat } = await import('../src/services/ai.service.js');
    const answerQueries = selectAnswerQueries(config.answerLimit);
    const answerOutcomes: AnswerOutcome[] = [];
    const answerRecords: Array<Record<string, unknown>> = [];
    const citationIntegrityFailures: string[] = [];
    const hallucinationRejections: Array<{ queryId: string; rejected: string[] }> = [];
    const providersUsed: Record<string, number> = {};

    for (const query of answerQueries) {
      const response = await chat(admin, config.userId, query.query, null, {
        useDocuments: true,
      });
      const provider = response.model.split(':')[0] ?? 'unknown';
      providersUsed[provider] = (providersUsed[provider] ?? 0) + 1;

      const sources = (response.sources ?? []) as DocumentSource[];
      for (const source of sources) {
        const document = await fetchDocument(admin, source.document_id);
        const chunk = await fetchChunk(admin, source.chunk_id);
        const integrity = checkCitationIntegrity({
          source,
          document,
          chunk,
          expectedUserId: config.userId,
        });
        if (!integrity.ok) {
          citationIntegrityFailures.push(`${query.id}:${source.marker ?? '?'}`);
        }
      }

      // Deliberately inject an invented marker and confirm it is rejected.
      const sourceMap = buildSourceMap(sources);
      const probe = `${response.reply} [S99]`;
      const validated = validateCitations(probe, sourceMap);
      if (validated.invalidMarkers.includes('S99')) {
        hallucinationRejections.push({ queryId: query.id, rejected: validated.invalidMarkers });
      }

      const availability = citationAvailability(sources);
      answerOutcomes.push(
        evaluateAnswerOutcome(
          query,
          response.reply,
          availability.total,
          availability.available,
        ),
      );
      answerRecords.push({
        id: query.id,
        category: query.category,
        provider,
        documentContextUsed: response.document_context_used ?? false,
        reply: response.reply,
        citations: sources.map((source) => ({
          marker: source.marker,
          documentId: source.document_id,
          chunkId: source.chunk_id,
          page: source.page,
          heading: source.heading,
        })),
        expectedAnswerContains: query.expectedAnswerContains ?? [],
        answerContainsExpected: query.expectedAnswerContains
          ? answerContainsAll(response.reply, query.expectedAnswerContains)
          : null,
        insufficientEvidence: answerOutcomes[answerOutcomes.length - 1]?.insufficientEvidence ?? false,
        leakedStrings: answerOutcomes[answerOutcomes.length - 1]?.leakedStrings ?? [],
      });
    }

    // -----------------------------------------------------------------------
    // Security checks: cross-user retrieval / access / deletion
    // -----------------------------------------------------------------------
    const securityChecks: Record<string, unknown> = {};
    if (config.createPeer) {
      const peer = await createPeerUser(admin, config.userEmailPrefix);
      if (peer) {
        peerUserId = peer.id;
        const firstDoc = seeds[0];
        if (firstDoc) {
          const queryEmbedding = await embed('remote work policy', { role: 'query' });
          const peerHits = await searchDocumentChunks(admin, peer.id, queryEmbedding, {
            threshold: 0,
            maxResults: 5,
            throwOnError: true,
          });
          securityChecks.crossUserRetrievalBlocked = peerHits.length === 0;

          let accessDenied = false;
          try {
            await getOwnedRow(admin, peer.id, firstDoc.documentId);
          } catch {
            accessDenied = true;
          }
          securityChecks.crossUserAccessDenied = accessDenied;

          let deletionDenied = false;
          try {
            await deleteDocument(admin, peer.id, firstDoc.documentId, storage);
          } catch {
            deletionDenied = true;
          }
          securityChecks.crossUserDeletionDenied = deletionDenied;
        }
      } else {
        securityChecks.peerUserCreated = false;
      }
    }

    // Signed-view metadata for the first document (no URL is persisted).
    const firstDoc = seeds[0];
    if (firstDoc) {
      const view = await getDocumentViewLink(admin, config.userId, firstDoc.documentId, storage);
      securityChecks.viewLink = {
        extension: view.extension,
        pageCount: view.page_count,
        expiresIn: view.expires_in,
        exposesStoragePath: /storage\/v1\/object|\.local-storage/i.test(view.url),
      };
    }

    const chunkCounts = new Map<string, number>();
    for (const chunk of chunks) {
      chunkCounts.set(chunk.document_id, (chunkCounts.get(chunk.document_id) ?? 0) + 1);
    }
    for (const seed of seeds) seed.chunkCount = chunkCounts.get(seed.documentId) ?? 0;

    const report = {
      generatedAt: isoNow(),
      startedAt,
      status: 'completed' as const,
      mode: 'live' as const,
      syntheticUser: { email, userId: config.userId, marker: CORPUS_USER_MARKER },
      previousEvalDocumentsRemoved: removed,
      dataset: {
        documents: seeds.length,
        formats: corpusSummary().formats,
        queries: QUERIES.length,
        scoredQueries: scoredResults.length,
        categories: queryCategoryCounts(),
        seeds,
      },
      config: {
        ...baseConfigReport(),
        corpusDocuments: seeds.length,
      },
      retrieval: {
        precisionAt5: retrieval.precisionAtK,
        recallAt5: retrieval.recallAtK,
        mrr: retrieval.mrr,
        relevantRetrievalRate: retrieval.relevantRetrievalRate,
        irrelevantInclusionRate: retrieval.irrelevantInclusionRate,
        scoredQueries: retrieval.scoredQueries,
        emptyQueryRejection: emptyQueryRejectionRate(),
        provenanceFailures,
        pageProvenance: {
          checked: pageExactChecks.length,
          exactStartPage: pageExactChecks.filter((check) => check.exact).length,
          exactStartPageRate:
            pageExactChecks.length === 0
              ? 0
              : pageExactChecks.filter((check) => check.exact).length / pageExactChecks.length,
          note:
            'Chunks may span pages by design. Containment is the correctness check; ' +
            'exactStartPage shows how often the chunk starts on the expected page.',
        },
        latency,
        perQuery: scoredResults.map((result) => ({
          id: result.query.id,
          category: result.query.category,
          expectedIds: result.expectedIds,
          retrievedIds: result.retrievedIds,
          precisionAt5: result.metrics.precisionAtK,
          recallAt5: result.metrics.recallAtK,
          reciprocalRank: result.metrics.reciprocalRank,
          firstRelevantRank: result.metrics.firstRelevantRank,
        })),
        rawRetrieval: retrievalByQuery,
      },
      answers: {
        evaluated: answerOutcomes.length,
        providersUsed,
        unsupportedAnswerRate: unsupportedAnswerRate(answerOutcomes),
        insufficientEvidenceRate: insufficientEvidenceRate(answerOutcomes),
        citationIntegrityFailures,
        hallucinationRejections,
        promptInjectionLeaks: answerOutcomes
          .filter((outcome) => outcome.leakedStrings.length > 0)
          .map((outcome) => ({
            id: outcome.query.id,
            leaked: outcome.leakedStrings,
          })),
        records: answerRecords,
      },
      securityChecks,
      limitations: [
        'Semantic citation support is not auto-judged. The report records a deterministic expected-phrase proxy plus the full cited text for human review.',
        'LLM-as-judge scoring was not used; no judge score is claimed.',
        'Ollama quality is only observed if a live fallback actually occurs; mock tests cover wiring, not model quality.',
        'DOCX has no page numbers by design; DOCX citations are validated by heading/section.',
      ],
    };

    const target = await writeJson(
      reportsDir,
      `document-rag-evaluation-${startedAt.replace(/[:.]/g, '-')}.json`,
      report,
    );

    console.log('Live document-RAG evaluation completed.');
    console.log(
      `P@5=${retrieval.precisionAtK.toFixed(3)} R@5=${retrieval.recallAtK.toFixed(3)} ` +
        `MRR=${retrieval.mrr.toFixed(3)} p50=${latency.p50Ms.toFixed(0)}ms p95=${latency.p95Ms.toFixed(0)}ms`,
    );
    console.log(`Report: ${target}`);
    return 0;
  } finally {
    // Cleanup only what this run created.
    for (const documentId of createdDocumentIds) {
      try {
        await deleteDocument(admin, config.userId, documentId, storage);
      } catch {
        // The sweeper retries storage deletes marked `deleting`.
      }
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const swept = await sweepDeletingDocuments({ client: admin });
      if (swept === 0) break;
      await sleep(250);
    }
    if (peerUserId) {
      try {
        await admin.auth.admin.deleteUser(peerUserId);
      } catch {
        // Peer cleanup is best-effort; it owns no documents.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const outputDir = envValue('EVAL_OUTPUT_DIR') || DEFAULT_OUTPUT_DIR;

  if (hasFlag('--self-check')) {
    return runSelfCheck(outputDir);
  }

  const live = readLiveConfig();
  if (!live) {
    const missing = missingLiveConfig();
    const reasons = [
      'The live evaluation is blocked by missing configuration.',
      'No score is fabricated or inferred.',
      'Run with --self-check to validate the corpus and query ground truth offline.',
    ];
    const report = blockedReport(missing, reasons);
    const target = await writeJson(outputDir, 'document-rag-evaluation-blocked.json', report);
    console.error('Document-RAG evaluation is BLOCKED.');
    console.error(`Missing environment variables: ${missing.join(', ') || '(none listed)'}`);
    console.error(`Blocked report: ${target}`);
    return 0;
  }

  if (!live.confirm) {
    const report = blockedReport([], [
      'Live write access was not confirmed.',
      'Set EVAL_CONFIRM=yes to upload synthetic documents and run the live evaluation.',
      'No score is fabricated or inferred.',
    ]);
    const target = await writeJson(outputDir, 'document-rag-evaluation-blocked.json', report);
    console.error('Live evaluation is BLOCKED: EVAL_CONFIRM=yes was not set.');
    console.error(`Blocked report: ${target}`);
    return 0;
  }

  return runLive(live);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // Never print credentials; upstream errors are already sanitized by the
    // services this script calls. Database/storage messages contain no secrets.
    console.error(`Document-RAG evaluation failed: ${message}`);
    process.exitCode = 1;
  });
