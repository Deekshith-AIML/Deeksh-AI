/**
 * tests/memory-eval.test.ts
 * -------------------------
 * Milestone 4.1 Task E — retrieval metric correctness.
 *
 * These are REAL assertions (the previous version only logged results):
 * - Precision@5, Recall@5 and MRR are computed from known expected ids.
 * - Rank indexing is 1-based: first relevant → reciprocal rank 1,
 *   second relevant → 0.5, none → 0.
 * - The service wiring is exercised against the in-memory Supabase fake
 *   with a known seed order.
 *
 * The live benchmark itself lives in `scripts/evaluate-memory-retrieval.ts`
 * and requires a running pgvector database; it is never part of `npm test`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  aggregateMetrics,
  computeQueryMetrics,
} from '../src/evaluation/retrieval-metrics.js';
import { retrieveMemories } from '../src/services/memory.service.js';
import {
  resetFakeSupabase,
  registerUser,
  fakeCreateUserScopedClient,
  fakeDb,
  forceMatchSimilarity,
} from './helpers/fakeSupabase.js';

const USER_ID = 'eval-user-001';
const TOKEN = 'eval-token';

describe('retrieval metrics — P@5 / Recall@5 / MRR', () => {
  it('rank 1 relevant result has reciprocal rank 1.0', () => {
    const m = computeQueryMetrics(['a'], ['a', 'b', 'c'], 5);
    expect(m.firstRelevantRank).toBe(1);
    expect(m.reciprocalRank).toBe(1);
    expect(m.hits).toBe(1);
    expect(m.precisionAtK).toBeCloseTo(1 / 5);
    expect(m.recallAtK).toBe(1);
  });

  it('rank 2 relevant result has reciprocal rank 0.5', () => {
    const m = computeQueryMetrics(['a'], ['x', 'a', 'y'], 5);
    expect(m.firstRelevantRank).toBe(2);
    expect(m.reciprocalRank).toBe(0.5);
  });

  it('no relevant result has reciprocal rank 0', () => {
    const m = computeQueryMetrics(['a'], ['x', 'y', 'z'], 5);
    expect(m.firstRelevantRank).toBeNull();
    expect(m.reciprocalRank).toBe(0);
    expect(m.hits).toBe(0);
    expect(m.precisionAtK).toBe(0);
    expect(m.recallAtK).toBe(0);
  });

  it('computes P@5 and Recall@5 from known expected ids', () => {
    const m = computeQueryMetrics(['a', 'b'], ['x', 'a', 'y', 'b', 'z'], 5);
    expect(m.hits).toBe(2);
    expect(m.precisionAtK).toBeCloseTo(2 / 5); // 2 hits / cutoff 5
    expect(m.recallAtK).toBe(1);               // 2 of 2 expected found
    expect(m.reciprocalRank).toBe(0.5);        // first hit at rank 2
  });

  it('ignores results outside the top-k cutoff', () => {
    const m = computeQueryMetrics(['a'], ['x', 'y', 'z', 'w', 'v', 'a'], 5);
    expect(m.hits).toBe(0);
    expect(m.reciprocalRank).toBe(0);
  });

  it('deduplicates expected ids so recall never exceeds 1', () => {
    const m = computeQueryMetrics(['a', 'a'], ['a'], 5);
    expect(m.recallAtK).toBe(1);
    expect(m.precisionAtK).toBeCloseTo(1 / 5);
  });

  it('aggregates the mean P@5, Recall@5 and MRR over scored queries', () => {
    const aggregate = aggregateMetrics([
      { expectedIds: ['a'], metrics: computeQueryMetrics(['a'], ['a'], 5) },       // P .2 R 1 RR 1
      { expectedIds: ['b'], metrics: computeQueryMetrics(['b'], ['x', 'b'], 5) },  // P .2 R 1 RR .5
      { expectedIds: [], metrics: computeQueryMetrics([], ['x'], 5) },             // excluded
    ]);

    expect(aggregate.scoredQueries).toBe(2);
    expect(aggregate.precisionAtK).toBeCloseTo(0.2);
    expect(aggregate.recallAtK).toBeCloseTo(1);
    expect(aggregate.mrr).toBeCloseTo(0.75);
    expect(aggregate.relevantRetrievalRate).toBe(1);
  });
});

describe('retrieval wiring — known seed ids', () => {
  beforeEach(() => {
    resetFakeSupabase();
    registerUser(TOKEN, USER_ID, 'eval@example.com');
    forceMatchSimilarity(null);
  });

  it('returns the expected ids and scores them correctly', async () => {
    const seededIds: string[] = [];
    for (let i = 0; i < 40; i++) {
      const id = `seed-${i}`;
      seededIds.push(id);
      fakeDb.memories.push({
        id,
        user_id: USER_ID,
        content: `memory ${i} about topic ${i % 5}`,
        content_summary: 'summary',
        category: 'personal_fact',
        embedding_provider: 'gemini',
        embedding_model_version: 'gemini-embedding-2',
        embedding_dimensions: 1536,
        source_message_id: null,
        source_evidence: null,
        confidence: 'high',
        status: 'active',
        superseded_by: null,
        supersession_confirmed_by_user: false,
        conflict_with: null,
        sensitivity: 'normal',
        extraction_timestamp: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_accessed_at: null,
        expired_at: null,
      });
    }

    const client = fakeCreateUserScopedClient(TOKEN);
    const { memories, count } = await retrieveMemories(client, USER_ID, [], {
      threshold: 0.65,
      maxResults: 5,
    });

    expect(count).toBe(5);
    const retrievedIds = memories.map((m) => m.id);
    // The fake returns insertion order for equal similarity, so the first
    // five seeds are the known relevant set for this deterministic check.
    const expectedIds = seededIds.slice(0, 5);

    const metrics = computeQueryMetrics(expectedIds, retrievedIds, 5);
    expect(metrics.hits).toBe(5);
    expect(metrics.precisionAtK).toBe(1);
    expect(metrics.recallAtK).toBe(1);
    expect(metrics.firstRelevantRank).toBe(1);
    expect(metrics.reciprocalRank).toBe(1);
  });
});
