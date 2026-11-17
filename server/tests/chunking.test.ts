import { describe, it, expect } from 'vitest';
import { chunkDocument, estimateTokens } from '../src/services/documents/chunking.js';
import type { ChunkProvenance } from '../src/services/documents/chunking.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';
import type { ExtractionResult } from '../src/services/documents/extraction/index.js';

const config = getDocumentsConfig();

/** Return the first chunk, failing the test clearly if chunking produced none. */
function getFirstChunk(chunks: ChunkProvenance[]): ChunkProvenance {
  const first = chunks[0];
  if (!first) throw new Error('Expected at least one chunk');
  return first;
}

interface StructuredParagraph {
  text: string;
  pageStart?: number | null;
  pageEnd?: number | null;
  heading?: string | null;
  sectionPath?: string | null;
}

/** Extraction fixture with explicit per-block provenance and cumulative offsets. */
function makeStructuredExtraction(entries: StructuredParagraph[]): ExtractionResult {
  let cursor = 0;
  const paragraphs = entries.map((entry, index) => {
    const charStart = cursor;
    const charEnd = charStart + entry.text.length;
    cursor = charEnd + 2; // account for the "\n\n" join used by totalText

    return {
      text: entry.text,
      provenance: {
        index,
        pageStart: entry.pageStart ?? null,
        pageEnd: entry.pageEnd ?? null,
        heading: entry.heading ?? null,
        sectionPath: entry.sectionPath ?? null,
        charStart,
        charEnd,
      },
      tokenEstimate: Math.max(1, Math.ceil(entry.text.length / 4)),
    };
  });

  return {
    totalText: entries.map((entry) => entry.text).join('\n\n'),
    paragraphs,
    totalPages: null,
    hasExtractableText: true,
    metadata: {
      encoding: 'utf-8',
      scanned: false,
      paragraphs: paragraphs.length,
      headings: 0,
      tables: 0,
      pages_with_text: 0,
      truncated: false,
    },
  };
}

function makeExtraction(paragraphs: string[], pages?: number[]): ExtractionResult {
  return {
    totalText: paragraphs.join('\n\n'),
    paragraphs: paragraphs.map((text, i) => {
      const page = pages?.[i] ?? null;
      return {
        text,
        provenance: {
          index: i,
          pageStart: page,
          pageEnd: page,
          heading: null,
          sectionPath: null,
          charStart: i * 100,
          charEnd: i * 100 + text.length,
        },
        tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
      };
    }),
    totalPages: pages && pages.length > 0 ? Math.max(...pages) : null,
    hasExtractableText: true,
    metadata: {
      encoding: 'utf-8',
      scanned: false,
      paragraphs: paragraphs.length,
      headings: 0,
      tables: 0,
      pages_with_text: pages ? new Set(pages).size : 0,
      truncated: false,
    },
  };
}

describe('M5 Phase 4 chunking', () => {
  it('chunks a simple document', () => {
    const extraction = makeExtraction([
      'This is paragraph one with some content.',
      'This is paragraph two with more content.',
      'This is paragraph three with even more content.',
    ]);
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.totalChunks).toBe(result.chunks.length);
    const first = getFirstChunk(result.chunks);
    expect(first.documentId).toBe('doc-1');
    expect(first.userId).toBe('user-1');
  });

  it('preserves page provenance', () => {
    const extraction = makeExtraction(
      ['Page one text.', 'Page two text.'],
      [1, 2],
    );
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    const first = getFirstChunk(result.chunks);
    expect(first.pageStart).toBe(1);
    expect(first.pageEnd).toBe(2);
  });

  it('estimates tokens correctly', () => {
    expect(estimateTokens('a'.repeat(100))).toBe(25);
    expect(estimateTokens('a'.repeat(4))).toBe(1);
    expect(estimateTokens('')).toBe(1);
  });

  it('respects max chunks limit', () => {
    const paragraphs = Array.from({ length: 5000 }, (_, i) => `Paragraph ${i} content.`);
    const extraction = makeExtraction(paragraphs);
    const smallConfig = { ...config, maxChunksPerDocument: 5 };
    const result = chunkDocument('doc-1', 'user-1', extraction, smallConfig);
    expect(result.chunks.length).toBeLessThanOrEqual(5);
  });

  it('handles empty extraction', () => {
    const extraction = makeExtraction([]);
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    expect(result.chunks.length).toBe(0);
  });

  it('preserves paragraph range', () => {
    const extraction = makeExtraction([
      'First paragraph.',
      'Second paragraph.',
      'Third paragraph.',
    ]);
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    const first = getFirstChunk(result.chunks);
    expect(first.paragraphStart).toBe(0);
    expect(first.paragraphEnd).toBeGreaterThanOrEqual(0);
  });

  it('chunks have sequential indices', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with some content to fill space.`);
    const extraction = makeExtraction(paragraphs);
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    for (let i = 0; i < result.chunks.length; i++) {
      const chunk = result.chunks[i];
      if (!chunk) throw new Error(`Expected chunk at index ${i}`);
      expect(chunk.chunkIndex).toBe(i);
    }
  });

  it('chunks have char offsets', () => {
    const extraction = makeExtraction(['Hello world.']);
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    const first = getFirstChunk(result.chunks);
    expect(first.charStart).toBeGreaterThanOrEqual(0);
    expect(first.charEnd).toBeGreaterThan(first.charStart);
  });
});

describe('M5 Corrective Patch 2 — oversized paragraph splitting', () => {
  const smallConfig = {
    ...config,
    chunkTargetTokens: 20,
    chunkOverlapTokens: 0,
  };

  it('splits an oversized paragraph at sentence boundaries', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`);
    const extraction = makeExtraction([sentences.join(' ')]);

    const result = chunkDocument('doc-1', 'user-1', extraction, smallConfig);

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(20);
      // Every emitted piece ends on a sentence terminator, never mid-sentence.
      expect(chunk.content.trimEnd().endsWith('.')).toBe(true);
    }

    // Every sentence survives somewhere in the output.
    const combined = result.chunks.map((chunk) => chunk.content).join(' ');
    for (const sentence of sentences) {
      expect(combined).toContain(sentence);
    }
  });

  it('splits at word boundaries when there is no sentence boundary', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const extraction = makeExtraction([words.join(' ')]);

    const result = chunkDocument('doc-1', 'user-1', extraction, smallConfig);
    expect(result.chunks.length).toBeGreaterThan(1);

    for (const chunk of result.chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(20);
      for (const token of chunk.content.split(/\s+/)) {
        // No word was cut in half.
        expect(token).toMatch(/^word\d+$/);
      }
    }

    const combined = result.chunks.map((chunk) => chunk.content).join(' ');
    for (const word of words) {
      expect(combined.split(/\s+/)).toContain(word);
    }
  });

  it('safely splits a single extremely long token', () => {
    const hugeToken = 'Z'.repeat(1000);
    const extraction = makeExtraction([hugeToken]);

    const result = chunkDocument('doc-1', 'user-1', extraction, smallConfig);

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(20);
      expect(chunk.content.length).toBeLessThanOrEqual(80);
    }
    expect(result.chunks.map((chunk) => chunk.content).join('')).toBe(hugeToken);
  });

  it('keeps every chunk within the token budget across mixed paragraphs', () => {
    const extraction = makeExtraction([
      'A short paragraph.',
      Array.from({ length: 30 }, () => 'A somewhat longer sentence with words.').join(' '),
      'word '.repeat(300),
      'Trailing paragraph.',
    ]);
    const target = 25;
    const bounded = { ...config, chunkTargetTokens: target, chunkOverlapTokens: 5 };

    const result = chunkDocument('doc-1', 'user-1', extraction, bounded);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(target);
    }
  });

  it('applies controlled overlap within a section', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `S${i} is here.`);
    const extraction = makeExtraction([sentences.join(' ')]);
    const overlapping = { ...config, chunkTargetTokens: 20, chunkOverlapTokens: 5 };

    const result = chunkDocument('doc-1', 'user-1', extraction, overlapping);
    expect(result.chunks.length).toBeGreaterThan(1);

    for (let i = 1; i < result.chunks.length; i += 1) {
      const current = result.chunks[i];
      const previous = result.chunks[i - 1];
      if (!current || !previous) throw new Error('Expected consecutive chunks');

      // Each chunk must still respect the budget despite the overlap.
      expect(estimateTokens(current.content)).toBeLessThanOrEqual(20);

      // The first sentence of this chunk was carried from the previous one.
      const firstToken = current.content.split(/\s+/)[0];
      if (!firstToken) throw new Error('Expected chunk content');
      expect(previous.content).toContain(firstToken);
    }
  });

  it('never blends unrelated heading/section boundaries', () => {
    const alpha = Array.from({ length: 20 }, () => 'ALPHAWORD sentence is here.').join(' ');
    const beta = Array.from({ length: 20 }, () => 'BETAWORD sentence is here.').join(' ');

    const extraction = makeStructuredExtraction([
      { text: 'Alpha Section', heading: 'Alpha Section', sectionPath: 'Alpha Section' },
      { text: alpha, heading: 'Alpha Section', sectionPath: 'Alpha Section' },
      { text: 'Beta Section', heading: 'Beta Section', sectionPath: 'Beta Section' },
      { text: beta, heading: 'Beta Section', sectionPath: 'Beta Section' },
    ]);

    const result = chunkDocument('doc-1', 'user-1', extraction, {
      ...config,
      chunkTargetTokens: 20,
      chunkOverlapTokens: 5,
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      const hasAlpha = chunk.content.includes('ALPHAWORD');
      const hasBeta = chunk.content.includes('BETAWORD');
      expect(hasAlpha && hasBeta).toBe(false);
      if (hasAlpha) expect(chunk.heading).toBe('Alpha Section');
      if (hasBeta) expect(chunk.heading).toBe('Beta Section');
    }
  });

  it('preserves page/heading/paragraph provenance after splitting', () => {
    const longText = Array.from({ length: 30 }, (_, i) => `Point ${i} is important.`).join(' ');
    const extraction = makeStructuredExtraction([
      {
        text: longText,
        pageStart: 3,
        pageEnd: 3,
        heading: 'Requirements',
        sectionPath: 'Spec > Requirements',
      },
    ]);

    const result = chunkDocument('doc-1', 'user-1', extraction, smallConfig);
    expect(result.chunks.length).toBeGreaterThan(1);

    for (const chunk of result.chunks) {
      expect(chunk.pageStart).toBe(3);
      expect(chunk.pageEnd).toBe(3);
      expect(chunk.heading).toBe('Requirements');
      expect(chunk.sectionPath).toBe('Spec > Requirements');
      expect(chunk.paragraphStart).toBe(0);
      expect(chunk.paragraphEnd).toBe(0);
      expect(chunk.charStart).toBeGreaterThanOrEqual(0);
      expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
    }
  });

  it('preserves real multi-page PDF provenance per chunk', () => {
    const pageText = (page: number) =>
      Array.from({ length: 20 }, (_, i) => `Page ${page} item ${i} details here.`).join(' ');

    const extraction = makeStructuredExtraction([
      { text: pageText(1), pageStart: 1, pageEnd: 1 },
      { text: pageText(2), pageStart: 2, pageEnd: 2 },
      { text: pageText(3), pageStart: 3, pageEnd: 3 },
    ]);

    const result = chunkDocument('doc-1', 'user-1', extraction, smallConfig);
    expect(result.chunks.length).toBeGreaterThan(3);

    for (const chunk of result.chunks) {
      expect(chunk.pageStart).not.toBeNull();
      expect(chunk.pageStart).toBe(chunk.pageEnd);

      const page = chunk.pageStart;
      if (!page) throw new Error('Expected page provenance');
      expect(chunk.content).toContain(`Page ${page} `);
    }
  });
});
