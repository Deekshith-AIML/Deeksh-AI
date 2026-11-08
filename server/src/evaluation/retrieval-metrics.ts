/**
 * evaluation/retrieval-metrics.ts
 * -------------------------------
 * Pure metric functions for the Milestone 4.1 retrieval benchmark.
 *
 * They are kept out of the script so they can be unit-tested with known
 * expected ids — no database or embedding provider required.
 *
 * Conventions:
 * - Results are ranked 1..k (first result = rank 1).
 * - Precision@k = relevant retrieved / k (fixed cutoff).
 * - Recall@k    = relevant retrieved / min(|expected|, k).
 * - Reciprocal rank = 1/rank of the FIRST relevant result, else 0.
 * - MRR is the mean reciprocal rank across queries.
 */

export interface QueryMetrics {
  /** Number of expected ids found in the top-k list. */
  hits: number;
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  /** 1-based rank of the first relevant result, or null when none. */
  firstRelevantRank: number | null;
}

export interface AggregateMetrics {
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
  /** Fraction of queries with at least one expected id retrieved. */
  relevantRetrievalRate: number;
  scoredQueries: number;
}

export function computeQueryMetrics(
  expectedIds: readonly string[],
  retrievedIds: readonly string[],
  k = 5,
): QueryMetrics {
  const uniqueExpected = Array.from(new Set(expectedIds));
  const topK = retrievedIds.slice(0, k);
  const hits = uniqueExpected.filter((id) => topK.includes(id)).length;

  const precisionAtK = k > 0 ? hits / k : 0;
  const recallAtK =
    uniqueExpected.length > 0 ? hits / Math.min(uniqueExpected.length, k) : 0;

  const firstIndex = topK.findIndex((id) => uniqueExpected.includes(id));
  const firstRelevantRank = firstIndex >= 0 ? firstIndex + 1 : null;
  const reciprocalRank = firstRelevantRank !== null ? 1 / firstRelevantRank : 0;

  return { hits, precisionAtK, recallAtK, reciprocalRank, firstRelevantRank };
}

export function aggregateMetrics(
  perQuery: ReadonlyArray<{ expectedIds: readonly string[]; metrics: QueryMetrics }>,
): AggregateMetrics {
  const scored = perQuery.filter((q) => q.expectedIds.length > 0);
  if (scored.length === 0) {
    return {
      precisionAtK: 0,
      recallAtK: 0,
      mrr: 0,
      relevantRetrievalRate: 0,
      scoredQueries: 0,
    };
  }

  const sum = (pick: (m: QueryMetrics) => number) =>
    scored.reduce((total, q) => total + pick(q.metrics), 0) / scored.length;

  return {
    precisionAtK: sum((m) => m.precisionAtK),
    recallAtK: sum((m) => m.recallAtK),
    mrr: sum((m) => m.reciprocalRank),
    relevantRetrievalRate: sum((m) => (m.hits > 0 ? 1 : 0)),
    scoredQueries: scored.length,
  };
}
