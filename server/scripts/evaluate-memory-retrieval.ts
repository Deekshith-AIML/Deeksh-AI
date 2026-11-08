/**
 * scripts/evaluate-memory-retrieval.ts
 * ------------------------------------
 * Live retrieval benchmark for Milestone 4.1 / 4.2.
 *
 * Seeds a controlled set of memories with REAL embeddings (provider from
 * env; default Gemini 1536-dims) into the local `chitti-pg` database, then
 * evaluates several retrieval configurations against the *actual*
 * `match_memories()` SQL function:
 *
 *   - vector-only at several thresholds (pre-M4.2 behaviour, p_query_text NULL)
 *   - hybrid lexical+vector at the same thresholds (M4.2, p_query_text supplied)
 *
 * The dataset is fixed so every query has a KNOWN expected id set:
 *   - 40 exact-reference queries, one per seed (unique `EVALTOKEN<i>` token)
 *   - 9 semantic queries, one per category
 *   - 1 irrelevant query (expected = none)
 *   - 1 empty query (expected = none, must return zero rows)
 *
 * Rank convention (1-based): first relevant → reciprocal rank 1.0,
 * second → 0.5, none → 0. MRR is the mean over queries with expected ids.
 *
 * Embeddings are computed ONCE and reused across configurations, so
 * before/after comparisons are not confounded by provider variance.
 *
 * SAFETY: only this benchmark's own rows for TEST_USER_ID are deleted
 * (`source_evidence LIKE 'bench:%'` or legacy `Evaluation seed #%`).
 *
 * Configurable env:
 *   EMBEDDING_PROVIDER=gemini|ollama
 *   DATABASE_URL (default local chitti-pg)
 *   EVAL_SEED_COUNT (default 40)
 *   EVAL_OUTPUT (optional file path for the JSON report)
 *
 * Exit code 0 on success. Never part of `npm test`.
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { embed, getActiveSpace, assertStorableInIndex } from '../src/services/embedding.service.js';
import { retrieveMemories } from '../src/services/memory.service.js';
import { computeQueryMetrics, aggregateMetrics } from '../src/evaluation/retrieval-metrics.js';
import { MEMORY_CATEGORIES } from '../../shared/schemas.js';
import type { MemoryCategory } from '../../shared/types.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const LOCAL_DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:55432/task_assistant';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const SEED_COUNT = Math.max(9, Number(process.env.EVAL_SEED_COUNT ?? 40));
const K = 5;

export interface SeedMemory {
  id: string;
  user_id: string;
  category: MemoryCategory;
  content: string;
  source_evidence: string;
}

const CATEGORY_PHRASES: Record<MemoryCategory, string> = {
  personal_fact: 'a personal fact about my hometown, family and day-to-day life',
  user_preference: 'a personal preference about how I like things to be arranged',
  career_goal: 'my career goal and the job role I am preparing for',
  project: 'a software project I am currently building',
  important_event: 'an important event or appointment in my calendar',
  learning_preference: 'how I prefer to learn and study new material',
  work_info: 'information about my current workplace and responsibilities',
  recurring_info: 'a recurring weekly routine or habit',
  other: 'a miscellaneous note I asked you to remember',
};

function buildSeedMemory(i: number): SeedMemory {
  const category = MEMORY_CATEGORIES[i % MEMORY_CATEGORIES.length]!;
  return {
    id: `seed-${i}`,
    user_id: TEST_USER_ID,
    category,
    content:
      `Evaluation memory ${i}: ${CATEGORY_PHRASES[category]}. ` +
      `My unique reference code is EVALTOKEN${i}.`,
    source_evidence: `bench:seed:${category}:${i}`,
  };
}

// ---------------------------------------------------------------------------
// Query catalogue
// ---------------------------------------------------------------------------
type QueryKind = 'exact' | 'semantic' | 'irrelevant' | 'empty';

interface TestQuery {
  label: string;
  text: string;
  expectedIds: string[];
  irrelevantSeeds: string[];
  empty?: boolean;
  kind: QueryKind;
}

function buildTestQueries(seedCount: number, seedToUuid: Map<string, string>): TestQuery[] {
  const getUuid = (seedId: string) => seedToUuid.get(seedId) ?? seedId;
  const queries: TestQuery[] = [];

  for (let i = 0; i < seedCount; i++) {
    queries.push({
      label: `Q_EXACT_${i}`,
      text: `EVALTOKEN${i}`,
      expectedIds: [getUuid(`seed-${i}`)],
      irrelevantSeeds: [getUuid(`seed-${(i + 1) % seedCount}`)],
      kind: 'exact',
    });
  }

  for (const category of MEMORY_CATEGORIES) {
    const expected: string[] = [];
    for (let i = 0; i < seedCount; i++) {
      if (buildSeedMemory(i).category === category) expected.push(getUuid(`seed-${i}`));
    }
    if (expected.length === 0) continue;
    queries.push({
      label: `Q_SEMANTIC_${category}`,
      text: CATEGORY_PHRASES[category],
      expectedIds: expected,
      irrelevantSeeds: [],
      kind: 'semantic',
    });
  }

  queries.push({
    label: 'Q_IRRELEVANT',
    text: 'the weather forecast for a football match in another country',
    expectedIds: [],
    irrelevantSeeds: [0, 1, 2].map((i) => getUuid(`seed-${i}`)),
    kind: 'irrelevant',
  });

  queries.push({
    label: 'Q_EMPTY',
    text: '',
    expectedIds: [],
    irrelevantSeeds: [],
    empty: true,
    kind: 'empty',
  });

  return queries;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
async function seedDatabase(
  pool: pg.Pool,
  spaces: ReturnType<typeof getActiveSpace>,
): Promise<Map<string, string>> {
  await pool.query(
    `DELETE FROM memories
      WHERE user_id = $1
        AND (source_evidence LIKE 'bench:%' OR content LIKE 'Evaluation seed #%')`,
    [TEST_USER_ID],
  );

  const inserted = new Map<string, string>();
  for (let i = 0; i < SEED_COUNT; i++) {
    const seed = buildSeedMemory(i);
    const emb = await embed(seed.content, { role: 'document' });
    assertStorableInIndex(
      { vector: emb, provider: spaces.provider, model: spaces.model, dimension: emb.length },
      spaces,
    );
    const vec = '[' + emb.join(',') + ']';
    const result = await pool.query(
      `INSERT INTO memories (user_id, content, category, embedding, source_message_id, source_evidence,
                             confidence, sensitivity, status, extraction_timestamp,
                             embedding_provider, embedding_model_version, embedding_dimensions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        TEST_USER_ID,
        seed.content,
        seed.category,
        vec,
        null,
        seed.source_evidence,
        'high',
        'normal',
        'active',
        new Date().toISOString(),
        spaces.provider,
        spaces.model,
        emb.length,
      ],
    );
    const row = result.rows[0] as { id: string } | undefined;
    if (!row) throw new Error(`Failed to insert seed ${i}: no row returned`);
    inserted.set(seed.id, row.id);
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
interface Config {
  label: string;
  mode: 'vector' | 'hybrid';
  threshold: number;
}

const CONFIGS: Config[] = [
  { label: 'vector@0.60', mode: 'vector', threshold: 0.6 },
  { label: 'vector@0.65', mode: 'vector', threshold: 0.65 },
  { label: 'vector@0.70', mode: 'vector', threshold: 0.7 },
  { label: 'vector@0.72', mode: 'vector', threshold: 0.72 },
  { label: 'vector@0.75', mode: 'vector', threshold: 0.75 },
  { label: 'hybrid@0.60', mode: 'hybrid', threshold: 0.6 },
  { label: 'hybrid@0.65', mode: 'hybrid', threshold: 0.65 },
  { label: 'hybrid@0.70', mode: 'hybrid', threshold: 0.7 },
  { label: 'hybrid@0.75', mode: 'hybrid', threshold: 0.75 },
];

interface QueryResult {
  label: string;
  kind: QueryKind;
  expectedIds: string[];
  retrieved: string[];
  irrelevantSeeds: string[];
  emptyRejected: boolean;
  metrics: ReturnType<typeof computeQueryMetrics>;
  latencyMs: number;
}

function summarize(rows: QueryResult[]) {
  const scored = rows.filter((r) => r.expectedIds.length > 0);
  const aggregate = aggregateMetrics(
    scored.map((r) => ({ expectedIds: r.expectedIds, metrics: r.metrics })),
  );
  const withIrrelevant = rows.filter((r) => r.irrelevantSeeds.length > 0);
  const irrelevantInclusionRate =
    withIrrelevant.length > 0
      ? withIrrelevant.filter((r) =>
          r.irrelevantSeeds.some((id) => r.retrieved.slice(0, K).includes(id)),
        ).length / withIrrelevant.length
      : 0;
  const emptyRows = rows.filter((r) => r.kind === 'empty');
  const emptyRejectionRate =
    emptyRows.length > 0
      ? emptyRows.filter((r) => r.emptyRejected).length / emptyRows.length
      : 0;
  const latencyRows = rows.filter((r) => r.latencyMs > 0);
  const avgLatencyMs =
    latencyRows.length > 0
      ? latencyRows.reduce((s, r) => s + r.latencyMs, 0) / latencyRows.length
      : 0;

  const byKind: Record<string, unknown> = {};
  for (const kind of ['exact', 'semantic'] as const) {
    const subset = scored.filter((r) => r.kind === kind);
    if (subset.length === 0) continue;
    const agg = aggregateMetrics(
      subset.map((r) => ({ expectedIds: r.expectedIds, metrics: r.metrics })),
    );
    byKind[kind] = {
      queries: agg.scoredQueries,
      precisionAt5: round(agg.precisionAtK),
      recallAt5: round(agg.recallAtK),
      mrr: round(agg.mrr),
      relevantRetrievalRate: round(agg.relevantRetrievalRate),
    };
  }

  return {
    scoredQueries: aggregate.scoredQueries,
    precisionAt5: round(aggregate.precisionAtK),
    recallAt5: round(aggregate.recallAtK),
    mrr: round(aggregate.mrr),
    relevantRetrievalRate: round(aggregate.relevantRetrievalRate),
    irrelevantInclusionRate: round(irrelevantInclusionRate),
    emptyQueryRejectionRate: round(emptyRejectionRate),
    avgDbRpcLatencyMs: round(avgLatencyMs, 3),
    byKind,
  };
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function evaluate() {
  const spaces = getActiveSpace();
  console.log('[retrieval-bench] provider:', process.env.EMBEDDING_PROVIDER ?? '(default gemini)');
  console.log('[retrieval-bench] active space:', spaces.provider, '/', spaces.model);

  const pool = new pg.Pool({ connectionString: LOCAL_DB_URL });
  try {
    await pool.query('SELECT 1');
    console.log('[retrieval-bench] local DB connected');
  } catch (e) {
    console.error('[retrieval-bench] Cannot connect to local DB:', e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log('[retrieval-bench] seeding', SEED_COUNT, 'memories ...');
  const seedToUuid = await seedDatabase(pool, spaces);
  const queries = buildTestQueries(SEED_COUNT, seedToUuid);

  // Embed each unique query text exactly once.
  console.log('[retrieval-bench] embedding', queries.filter((q) => q.text.trim()).length, 'queries ...');
  const embeddings = new Map<string, number[]>();
  for (const q of queries) {
    if (!q.text.trim()) continue;
    if (!embeddings.has(q.text)) {
      embeddings.set(q.text, await embed(q.text, { role: 'query' }));
    }
  }

  // Client wrapper executing the REAL match_memories SQL function, exactly as
  // PostgREST would, including the optional hybrid query text.
  const localClient = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'match_memories') {
        return {
          data: null,
          error: { message: `function ${fn}() not implemented in local client`, code: 'PGRST202' },
        };
      }
      const userId = String(args.p_user_id ?? '');
      const threshold = Number(args.match_threshold ?? 0.65);
      const count = Math.min(Number(args.match_count ?? 8), 50);
      const category = args.p_category ? String(args.p_category) : null;
      const queryText = args.p_query_text ? String(args.p_query_text) : null;
      const queryEmbedding = args.query_embedding as number[];
      if (!userId) {
        return { data: null, error: { message: 'p_user_id is required', code: 'PGRST202' } };
      }
      if (!queryEmbedding || !Array.isArray(queryEmbedding)) {
        return { data: null, error: { message: 'query_embedding required', code: 'PGRST202' } };
      }
      const vecStr = '[' + queryEmbedding.join(',') + ']';
      const result = await pool.query(
        `SELECT memory_id, user_id, content, category, similarity, created_at
           FROM public.match_memories($1::vector, $2::uuid, $3::float, $4::int, $5::text, $6::text)`,
        [vecStr, userId, threshold, count, category, queryText],
      );
      return { data: result.rows, error: null };
    },
  } as unknown as SupabaseClient;

  const configReports: Array<Record<string, unknown>> = [];

  for (const config of CONFIGS) {
    console.log('[retrieval-bench] evaluating', config.label, '...');
    const results: QueryResult[] = [];

    for (const q of queries) {
      const queryEmbedding = q.text.trim() ? embeddings.get(q.text) ?? null : null;

      let retrieved: string[] = [];
      let latencyMs = 0;
      if (queryEmbedding) {
        const started = performance.now();
        const { memories } = await retrieveMemories(localClient, TEST_USER_ID, queryEmbedding, {
          threshold: config.threshold,
          maxResults: K,
          queryText: config.mode === 'hybrid' ? q.text : null,
        });
        latencyMs = performance.now() - started;
        retrieved = memories.map((m) => m.id);
      }

      results.push({
        label: q.label,
        kind: q.kind,
        expectedIds: q.expectedIds,
        retrieved,
        irrelevantSeeds: q.irrelevantSeeds,
        emptyRejected: q.empty === true && retrieved.length === 0,
        metrics: computeQueryMetrics(q.expectedIds, retrieved, K),
        latencyMs,
      });
    }

    configReports.push({
      label: config.label,
      mode: config.mode,
      threshold: config.threshold,
      ...summarize(results),
    });
  }

  const report = {
    provider: spaces.provider,
    model: spaces.model,
    dimensions: spaces.dimension || 1536,
    seededMemories: SEED_COUNT,
    queriesEvaluated: queries.length,
    cutoffK: K,
    note:
      'avgDbRpcLatencyMs measures the local PostgreSQL RPC round-trip only; ' +
      'it excludes PostgREST/network overhead.',
    configs: configReports,
    warnings: [
      'Ollama (embeddinggemma, 768 dims) cannot serve vector(1536) — isolated evaluation only.',
      'Synthetic dataset with distinctive tokens; exact-query gains reflect lexical matching, not general semantic quality.',
      'Irrelevant-inclusion is measured only on queries that declare irrelevant seeds.',
    ],
  };

  console.log(JSON.stringify(report, null, 2));
  if (process.env.EVAL_OUTPUT) {
    writeFileSync(process.env.EVAL_OUTPUT, JSON.stringify(report, null, 2), 'utf8');
    console.log('[retrieval-bench] wrote', process.env.EVAL_OUTPUT);
  }
  await pool.end();
  process.exit(0);
}

evaluate().catch((err) => {
  console.error('[retrieval-bench] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
