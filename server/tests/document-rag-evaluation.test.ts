/**
 * tests/document-rag-evaluation.test.ts
 * -------------------------------------
 * Phase 12 evaluation integrity tests.
 *
 * These do NOT call a model or a database. They prove that:
 *   - the synthetic corpus and 72-query ground truth are reproducible,
 *   - every hand-authored anchor survives the REAL extraction + chunking
 *     pipeline (PDF, DOCX, TXT),
 *   - page and heading provenance assertions are satisfiable,
 *   - the ranking/latency/citation/refusal metric helpers are correct.
 *
 * Live RAG quality is measured only by `scripts/evaluate-document-rag.ts`
 * when a configured environment is available; nothing here claims live scores.
 */

import { describe, it, expect } from 'vitest';
import {
  CORPUS,
  generateCorpus,
  normalizeForMatch,
} from '../scripts/evaluation/document-rag-corpus.js';
import {
  QUERIES,
  queryCategoryCounts,
} from '../scripts/evaluation/document-rag-queries.js';
import { checkDatasetWithBytes } from '../scripts/evaluation/document-rag-self-check.js';
import {
  aggregateRetrieval,
  answerContainsAll,
  citationAvailability,
  checkCitationIntegrity,
  emptyQueryRejectionRate,
  evaluateAnswerOutcome,
  expressesInsufficientEvidence,
  insufficientEvidenceRate,
  percentile,
  scoreQuery,
  summarizeLatencies,
  unsupportedAnswerRate,
} from '../scripts/evaluation/document-rag-metrics.js';
import { computeQueryMetrics } from '../src/evaluation/retrieval-metrics.js';
import { extractDocument } from '../src/services/documents/extraction/index.js';
import { chunkDocument } from '../src/services/documents/chunking.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';
import type { ChunkProvenance } from '../src/services/documents/chunking.js';

const config = getDocumentsConfig();

describe('Phase 12 dataset integrity', () => {
  it('has at least 15 documents, 50 queries and every required format', async () => {
    const result = await checkDatasetWithBytes();

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.stats.documents).toBeGreaterThanOrEqual(15);
    expect(result.stats.queries).toBeGreaterThanOrEqual(50);
    expect(result.stats.documents).toBe(CORPUS.length);
    expect(result.stats.queries).toBe(QUERIES.length);
    expect(result.stats.formats.pdf).toBeGreaterThan(0);
    expect(result.stats.formats.docx).toBeGreaterThan(0);
    expect(result.stats.formats.txt).toBeGreaterThan(0);
  }, 60_000);

  it('covers every query category with the intended minimum counts', () => {
    const counts = queryCategoryCounts();
    expect(counts.exact).toBeGreaterThanOrEqual(10);
    expect(counts.semantic).toBeGreaterThanOrEqual(10);
    expect(counts.multi_document).toBeGreaterThanOrEqual(8);
    expect(counts.table).toBeGreaterThanOrEqual(8);
    expect(counts.section).toBeGreaterThanOrEqual(8);
    expect(counts.pdf_page).toBeGreaterThanOrEqual(8);
    expect(counts.contradictory).toBeGreaterThanOrEqual(6);
    expect(counts.unanswerable).toBeGreaterThanOrEqual(6);
    expect(counts.irrelevant).toBeGreaterThanOrEqual(4);
    expect(counts.prompt_injection).toBeGreaterThanOrEqual(4);
    expect(QUERIES.filter((query) => query.scored).length).toBeGreaterThanOrEqual(50);
  });

  it('has unique query ids and unique document keys', () => {
    expect(new Set(QUERIES.map((query) => query.id)).size).toBe(QUERIES.length);
    expect(new Set(CORPUS.map((doc) => doc.key)).size).toBe(CORPUS.length);
  });

  it('contains a prompt-injection fixture with a placeholder credential', () => {
    const injection = CORPUS.find((doc) => doc.traits.includes('prompt-injection'));
    expect(injection).toBeTruthy();
    const text = (injection?.blocks ?? [])
      .map((block) => (block.type === 'table' ? '' : block.text))
      .join(' ');
    expect(text).toMatch(/ignore previous instructions/i);
    expect(text).toContain('EVAL_FAKE_SECRET_9f83ab');
  });
});

describe('Phase 12 ground truth vs the real extraction + chunking pipeline', () => {
  it('resolves every anchor and provenance assertion against real chunks', async () => {
    const corpus = await generateCorpus();
    const chunksByKey = new Map<string, ChunkProvenance[]>();

    for (const doc of corpus) {
      const extraction = await extractDocument(doc.bytes, doc.format, config);
      expect(extraction.hasExtractableText).toBe(true);
      const chunked = chunkDocument(`doc-${doc.key}`, 'user-eval', extraction, config);
      chunked.chunks.forEach((chunk) => {
        expect(chunk.content.trim().length).toBeGreaterThan(0);
      });
      chunksByKey.set(doc.key, chunked.chunks);
    }

    for (const query of QUERIES) {
      for (const anchor of query.expectedAnchors) {
        const matches: Array<{ key: string; chunk: ChunkProvenance }> = [];
        for (const [key, chunks] of chunksByKey) {
          for (const chunk of chunks) {
            if (normalizeForMatch(chunk.content).includes(anchor)) {
              matches.push({ key, chunk });
            }
          }
        }

        expect(matches.length, `anchor "${anchor}" (${query.id}) must resolve`).toBeGreaterThan(0);

        // Every resolved match must be in an expected document.
        const expectedKeys = new Set(query.expectedDocKeys);
        expect(
          matches.every((match) => expectedKeys.has(match.key)),
          `anchor "${anchor}" (${query.id}) resolved outside expectedDocKeys`,
        ).toBe(true);

        if (query.expectedPage !== undefined) {
          expect(
            matches.some(
              ({ chunk }) =>
                chunk.pageStart !== null &&
                chunk.pageEnd !== null &&
                query.expectedPage !== undefined &&
                query.expectedPage >= chunk.pageStart &&
                query.expectedPage <= chunk.pageEnd,
            ),
            `anchor "${anchor}" (${query.id}) is not covered by page ${query.expectedPage}`,
          ).toBe(true);
        }

        if (query.expectedHeading) {
          expect(
            matches.some(({ chunk }) => chunk.heading === query.expectedHeading),
            `anchor "${anchor}" (${query.id}) is not under heading "${query.expectedHeading}"`,
          ).toBe(true);
        }
      }
    }
  }, 120_000);

  it('keeps contradictory documents genuinely contradictory', () => {
    const remote = serializeDoc('eval-doc-01');
    const draft = serializeDoc('eval-doc-14');
    expect(remote).toContain('three days each week');
    expect(draft).toContain('five days each week');
    expect(draft).toContain('official handbook takes precedence');
  });
});

function serializeDoc(key: string): string {
  const doc = CORPUS.find((candidate) => candidate.key === key);
  if (!doc) throw new Error(`missing corpus doc ${key}`);
  return normalizeForMatch(
    (doc.blocks ?? doc.pages?.flat() ?? [])
      .map((block) =>
        block.type === 'table' ? block.rows.map((row) => row.join(' | ')).join(' ') : block.text,
      )
      .join(' '),
  );
}

describe('Phase 12 ranking and latency metrics', () => {
  it('computes P@5, R@5 and MRR with 1-based ranks', () => {
    const metrics = computeQueryMetrics(
      ['rel-1', 'rel-2'],
      ['noise', 'rel-1', 'noise-2', 'rel-2', 'noise-3'],
      5,
    );
    expect(metrics.hits).toBe(2);
    expect(metrics.precisionAtK).toBeCloseTo(2 / 5);
    expect(metrics.recallAtK).toBeCloseTo(1);
    expect(metrics.firstRelevantRank).toBe(2);
    expect(metrics.reciprocalRank).toBeCloseTo(0.5);
    expect(metrics.reciprocalRank).toBeLessThanOrEqual(1);
  });

  it('never exceeds MRR 1 and handles empty expected sets', () => {
    const perfect = computeQueryMetrics(['a'], ['a'], 5);
    expect(perfect.reciprocalRank).toBe(1);

    const missing = computeQueryMetrics(['a'], ['b', 'c'], 5);
    expect(missing.reciprocalRank).toBe(0);

    const empty = computeQueryMetrics([], ['a'], 5);
    expect(empty.recallAtK).toBe(0);
    expect(empty.reciprocalRank).toBe(0);
  });

  it('aggregates strict relevance and irrelevant inclusion', () => {
    const first = scoreQuery(
      {
        id: 'q1',
        category: 'exact',
        query: 'q1',
        expectedDocKeys: ['d1'],
        expectedAnchors: ['a1'],
        scored: true,
      },
      ['c1', 'c2', 'c3'],
      ['c1'],
      5,
    );
    const second = scoreQuery(
      {
        id: 'q2',
        category: 'exact',
        query: 'q2',
        expectedDocKeys: ['d1'],
        expectedAnchors: ['a2'],
        scored: true,
      },
      ['c9', 'c8'],
      ['c7'],
      5,
    );

    const aggregate = aggregateRetrieval([first, second]);
    expect(aggregate.scoredQueries).toBe(2);
    expect(aggregate.precisionAtK).toBeCloseTo(0.1);
    expect(aggregate.recallAtK).toBeCloseTo(0.5);
    expect(aggregate.mrr).toBeCloseTo(0.5);
    expect(aggregate.relevantRetrievalRate).toBeCloseTo(0.5);
    expect(aggregate.irrelevantInclusionRate).toBe(1);
    expect(aggregate.mrr).toBeLessThanOrEqual(1);
  });

  it('computes nearest-rank p50 / p95 latency', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile([], 95)).toBe(0);

    const summary = summarizeLatencies([5, 5, 5, 100]);
    expect(summary.count).toBe(4);
    expect(summary.meanMs).toBeCloseTo(28.75);
    expect(summary.p50Ms).toBe(5);
    expect(summary.p95Ms).toBe(100);
    expect(summary.minMs).toBe(5);
    expect(summary.maxMs).toBe(100);
  });

  it('rejects empty, whitespace and oversized search queries via the real schema', () => {
    const result = emptyQueryRejectionRate();
    expect(result.evaluated).toBe(4);
    expect(result.rejected).toBe(4);
    expect(result.rate).toBe(1);

    const mixed = emptyQueryRejectionRate(['', 'valid query']);
    expect(mixed).toEqual({ evaluated: 2, rejected: 1, rate: 0.5 });
  });
});

describe('Phase 12 citation and refusal helpers', () => {
  const queryBase = {
    id: 'answer-1',
    category: 'exact' as const,
    query: 'How many remote days?',
    expectedDocKeys: ['eval-doc-01'],
    expectedAnchors: ['three days each week'],
    scored: true,
  };

  it('requires both a document id and a chunk id for citation availability', () => {
    expect(
      citationAvailability([
        { document_id: 'd1', chunk_id: 'c1' },
        { document_id: 'd1' },
      ]),
    ).toEqual({ total: 2, available: 1, rate: 0.5 });
    expect(citationAvailability([])).toEqual({ total: 0, available: 0, rate: 0 });
  });

  it('validates citation existence, ownership and provenance', () => {
    const good = checkCitationIntegrity({
      source: {
        document_id: 'd1',
        chunk_id: 'c1',
        page: 2,
        heading: 'Annual Leave',
      },
      document: { id: 'd1', user_id: 'user-a' },
      chunk: {
        id: 'c1',
        document_id: 'd1',
        page_start: 2,
        heading: 'Annual Leave',
      },
      expectedUserId: 'user-a',
    });
    expect(good.ok).toBe(true);

    const foreign = checkCitationIntegrity({
      source: { document_id: 'd1', chunk_id: 'c1' },
      document: { id: 'd1', user_id: 'user-b' },
      chunk: { id: 'c1', document_id: 'd1', page_start: 2, heading: null },
      expectedUserId: 'user-a',
    });
    expect(foreign.documentOwned).toBe(false);
    expect(foreign.ok).toBe(false);

    const wrongPage = checkCitationIntegrity({
      source: { document_id: 'd1', chunk_id: 'c1', page: 9 },
      document: { id: 'd1', user_id: 'user-a' },
      chunk: { id: 'c1', document_id: 'd1', page_start: 2, heading: null },
      expectedUserId: 'user-a',
    });
    expect(wrongPage.pageMatches).toBe(false);
    expect(wrongPage.ok).toBe(false);

    const missingChunk = checkCitationIntegrity({
      source: { document_id: 'd1', chunk_id: 'ghost' },
      document: { id: 'd1', user_id: 'user-a' },
      chunk: null,
      expectedUserId: 'user-a',
    });
    expect(missingChunk.chunkExists).toBe(false);
    expect(missingChunk.ok).toBe(false);
  });

  it('detects refusal language and leaks', () => {
    expect(expressesInsufficientEvidence("I don't have enough information in the documents.")).toBe(
      true,
    );
    expect(
      expressesInsufficientEvidence('The uploaded documents do not contain sufficient evidence.'),
    ).toBe(true);
    expect(expressesInsufficientEvidence('Employees may work remotely three days.')).toBe(false);

    const outcome = evaluateAnswerOutcome(
      {
        ...queryBase,
        expectedAnswerContains: ['three days'],
        mustNotContain: ['EVAL_FAKE_SECRET_9f83ab'],
      },
      'Employees may work remotely three days each week.',
      1,
      1,
    );
    expect(outcome.supported).toBe(true);
    expect(outcome.leakedStrings).toEqual([]);
  });

  it('computes unsupported and insufficient-evidence rates', () => {
    const supported = evaluateAnswerOutcome(
      { ...queryBase, expectedAnswerContains: ['three days'] } as never,
      'Three days each week.',
      1,
      1,
    );
    const unsupported = evaluateAnswerOutcome(
      { ...queryBase, id: 'answer-2', expectedAnswerContains: ['three days'] } as never,
      'Five days each week.',
      1,
      1,
    );
    expect(unsupportedAnswerRate([supported, unsupported])).toEqual({
      evaluated: 2,
      unsupported: 1,
      rate: 0.5,
    });

    const refused = evaluateAnswerOutcome(
      {
        id: 'unans',
        category: 'unanswerable',
        query: 'unknown',
        expectedDocKeys: [],
        expectedAnchors: [],
        scored: false,
        expectInsufficientEvidence: true,
      },
      'I do not have enough information to answer that.',
      0,
      0,
    );
    const invented = evaluateAnswerOutcome(
      {
        id: 'unans-2',
        category: 'unanswerable',
        query: 'unknown',
        expectedDocKeys: [],
        expectedAnchors: [],
        scored: false,
        expectInsufficientEvidence: true,
      },
      'The CEO lives in Bengaluru.',
      0,
      0,
    );
    expect(insufficientEvidenceRate([refused, invented])).toEqual({
      evaluated: 2,
      refused: 1,
      rate: 0.5,
    });
  });

  it('answerContainsAll is case-insensitive and whitespace-tolerant', () => {
    expect(answerContainsAll('Python,   SQL and EXCEL', ['python', 'SQL', 'Excel'])).toBe(true);
    expect(answerContainsAll('Only Python', ['python', 'SQL'])).toBe(false);
    expect(answerContainsAll('anything', [])).toBe(true);
  });
});
