/**
 * scripts/evaluation/document-rag-metrics.ts
 * ------------------------------------------
 * Pure metric helpers for the Phase 12 document-RAG evaluation.
 *
 * Ranking metrics reuse the production `retrieval-metrics.ts` implementation
 * (1-based ranks, MRR <= 1). The helpers here add latency percentiles,
 * citation availability, refusal detection and deterministic answer checks.
 *
 * Everything is pure so it can be unit tested without a database, embeddings
 * or a model provider.
 */

import {
  aggregateMetrics,
  computeQueryMetrics,
  type AggregateMetrics,
  type QueryMetrics,
} from '../../src/evaluation/retrieval-metrics.js';
import type { EvalQuery } from './document-rag-queries.js';
import { documentSearchSchema } from '../../../shared/schemas.js';

export interface LatencySummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

/** Nearest-rank percentile. `p` is 0..100. Returns 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const clamped = Math.min(Math.max(p, 0), 100);
  const rank = Math.ceil((clamped / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) {
    return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0 };
  }
  const sum = finite.reduce((total, v) => total + v, 0);
  return {
    count: finite.length,
    meanMs: sum / finite.length,
    p50Ms: percentile(finite, 50),
    p95Ms: percentile(finite, 95),
    minMs: Math.min(...finite),
    maxMs: Math.max(...finite),
  };
}

export interface ScoredQueryResult {
  query: EvalQuery;
  retrievedIds: string[];
  expectedIds: string[];
  metrics: QueryMetrics;
}

export function scoreQuery(
  query: EvalQuery,
  retrievedIds: readonly string[],
  expectedIds: readonly string[],
  k = 5,
): ScoredQueryResult {
  return {
    query,
    retrievedIds: retrievedIds.slice(0, k),
    expectedIds: [...expectedIds],
    metrics: computeQueryMetrics(expectedIds, retrievedIds, k),
  };
}

export interface RetrievalAggregate extends AggregateMetrics {
  /** Mean number of retrieved chunks that were NOT expected, per query. */
  irrelevantInclusionRate: number;
  /** Fraction of queries where at least one expected chunk was retrieved. */
  relevantRetrievalRate: number;
  scoredQueries: number;
}

/**
 * Aggregate scored queries.
 *
 * `irrelevantInclusionRate` is the fraction of scored queries whose top-k
 * contained at least one chunk outside the known expected set. It is a
 * strict measure: a chunk is irrelevant unless it is in the hand-authored
 * expected set. Semantically related chunks are NOT counted as relevant.
 */
export function aggregateRetrieval(
  results: ReadonlyArray<ScoredQueryResult>,
): RetrievalAggregate {
  const base = aggregateMetrics(
    results.map((r) => ({ expectedIds: r.expectedIds, metrics: r.metrics })),
  );
  if (results.length === 0) {
    return { ...base, irrelevantInclusionRate: 0, relevantRetrievalRate: 0, scoredQueries: 0 };
  }
  const withIrrelevant = results.filter((r) =>
    r.retrievedIds.some((id) => !r.expectedIds.includes(id)),
  ).length;
  return {
    ...base,
    irrelevantInclusionRate: withIrrelevant / results.length,
    relevantRetrievalRate: base.relevantRetrievalRate,
    scoredQueries: results.length,
  };
}

// ---------------------------------------------------------------------------
// Empty-query rejection (schema-level, exercised by the search endpoint)
// ---------------------------------------------------------------------------

/**
 * Rejection rate for queries that must never reach retrieval. Uses the real
 * `documentSearchSchema`, so this measures the production validation rule.
 */
export function emptyQueryRejectionRate(
  candidates: readonly string[] = ['', '   ', '\n\t', 'x'.repeat(2001)],
): { evaluated: number; rejected: number; rate: number } {
  const evaluated = candidates.length;
  const rejected = candidates.filter(
    (query) => !documentSearchSchema.safeParse({ query }).success,
  ).length;
  return { evaluated, rejected, rate: evaluated === 0 ? 0 : rejected / evaluated };
}

// ---------------------------------------------------------------------------
// Answer / citation checks
// ---------------------------------------------------------------------------

export function normalizeAnswerText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** True when every expected phrase appears in the reply (case-insensitive). */
export function answerContainsAll(reply: string, phrases: readonly string[]): boolean {
  if (phrases.length === 0) return true;
  const normalized = normalizeAnswerText(reply);
  return phrases.every((phrase) => normalized.includes(normalizeAnswerText(phrase)));
}

const INSUFFICIENT_PATTERNS: readonly RegExp[] = [
  /\bi (?:do not|don't) have (?:enough )?information\b/i,
  /\bi (?:do not|don't) know\b/i,
  /\bnot (?:mentioned|provided|available|specified|found|covered)\b/i,
  /\bno (?:information|mention|record|evidence)\b/i,
  /\binsufficient (?:evidence|information|context)\b/i,
  /\bcannot (?:find|determine|answer|locate)\b/i,
  /\bcan't (?:find|determine|answer|locate)\b/i,
  /\bunable to (?:find|determine|answer|locate)\b/i,
  /\bthe (?:documents?|sources?|context) (?:do not|don't) (?:mention|contain|include|say)\b/i,
  /\b(?:uploaded |provided |available )?(?:documents?|sources?|context)\b[^.]*\b(?:do not|don't|does not|doesn't)\b[^.]*\b(?:mention|contain|include|provide|say)\b/i,
  /\b(?:do not|don't|does not|doesn't) contain (?:the |sufficient |enough )?(?:answer|evidence|information)\b/i,
  /\b(?:insufficient|not enough)\b[^.]*\b(?:evidence|information|context)\b/i,
  /\bnot present in the (?:documents?|sources?|context)\b/i,
];

export function expressesInsufficientEvidence(reply: string): boolean {
  return INSUFFICIENT_PATTERNS.some((pattern) => pattern.test(reply));
}

export interface CitationSourceLike {
  document_id?: string;
  chunk_id?: string;
  page?: number | null;
  heading?: string | null;
  marker?: string;
}

/**
 * Citation source availability: every cited source must carry both a document
 * id and a chunk id. A document id alone is not a resolvable citation.
 */
export function citationAvailability(sources: readonly CitationSourceLike[]): {
  total: number;
  available: number;
  rate: number;
} {
  const total = sources.length;
  const available = sources.filter(
    (source) => Boolean(source.document_id) && Boolean(source.chunk_id),
  ).length;
  return { total, available, rate: total === 0 ? 0 : available / total };
}

export interface CitationIntegrityCheck {
  documentExists: boolean;
  documentOwned: boolean;
  chunkExists: boolean;
  chunkBelongsToDocument: boolean;
  pageMatches: boolean;
  headingMatches: boolean;
  ok: boolean;
}

/**
 * Deterministic citation integrity check.
 *
 * `supportsClaim` is intentionally NOT computed here: deciding whether a chunk
 * semantically supports a sentence needs human review or a judge. This helper
 * only verifies the mechanical facts (existence, ownership, provenance).
 * The evaluation script records the cited text separately for the documented
 * support proxy.
 */
export function checkCitationIntegrity(params: {
  source: CitationSourceLike;
  document: { id: string; user_id: string } | null;
  chunk:
    | {
        id: string;
        document_id: string;
        page_start: number | null;
        heading: string | null;
      }
    | null;
  expectedUserId: string;
}): CitationIntegrityCheck {
  const { source, document, chunk, expectedUserId } = params;
  const documentExists = document !== null;
  const documentOwned = document?.user_id === expectedUserId;
  const chunkExists = chunk !== null;
  const chunkBelongsToDocument = Boolean(
    document && chunk && chunk.document_id === document.id,
  );
  const pageMatches =
    source.page === undefined ||
    source.page === null ||
    (chunk !== null && chunk.page_start === source.page);
  const headingMatches =
    source.heading === undefined ||
    source.heading === null ||
    (chunk !== null && chunk.heading === source.heading);

  return {
    documentExists,
    documentOwned,
    chunkExists,
    chunkBelongsToDocument,
    pageMatches,
    headingMatches,
    ok:
      documentExists &&
      documentOwned &&
      chunkExists &&
      chunkBelongsToDocument &&
      pageMatches &&
      headingMatches,
  };
}

/**
 * Deterministic support proxy for an answerable query: the reply must contain
 * every `expectedAnswerContains` phrase. This is not a semantic judge; it is a
 * fixed string assertion authored with the corpus.
 */
export function answerSupported(query: EvalQuery, reply: string): boolean | null {
  if (!query.expectedAnswerContains || query.expectedAnswerContains.length === 0) return null;
  return answerContainsAll(reply, query.expectedAnswerContains);
}

export interface AnswerOutcome {
  query: EvalQuery;
  reply: string;
  /** True when the deterministic answer proxy passed (null = not applicable). */
  supported: boolean | null;
  /** True when a refusal/insufficient-evidence phrase was detected. */
  insufficientEvidence: boolean;
  /** Prompt-injection strings that leaked into the reply. */
  leakedStrings: string[];
  citationAvailable: number;
  citationTotal: number;
}

export function evaluateAnswerOutcome(
  query: EvalQuery,
  reply: string,
  citationTotal: number,
  citationAvailable: number,
): AnswerOutcome {
  const leaked = (query.mustNotContain ?? []).filter((needle) =>
    reply.includes(needle),
  );
  return {
    query,
    reply,
    supported: answerSupported(query, reply),
    insufficientEvidence: expressesInsufficientEvidence(reply),
    leakedStrings: leaked,
    citationAvailable,
    citationTotal,
  };
}

/** Unsupported answer rate: answered but failed the deterministic proxy. */
export function unsupportedAnswerRate(outcomes: readonly AnswerOutcome[]): {
  evaluated: number;
  unsupported: number;
  rate: number;
} {
  const evaluated = outcomes.filter((o) => o.supported !== null);
  const unsupported = evaluated.filter((o) => o.supported === false).length;
  return {
    evaluated: evaluated.length,
    unsupported,
    rate: evaluated.length === 0 ? 0 : unsupported / evaluated.length,
  };
}

/** Refusal rate over queries that must not be answered from absent evidence. */
export function insufficientEvidenceRate(outcomes: readonly AnswerOutcome[]): {
  evaluated: number;
  refused: number;
  rate: number;
} {
  const evaluated = outcomes.filter((o) => o.query.expectInsufficientEvidence === true);
  const refused = evaluated.filter((o) => o.insufficientEvidence).length;
  return {
    evaluated: evaluated.length,
    refused,
    rate: evaluated.length === 0 ? 0 : refused / evaluated.length,
  };
}
