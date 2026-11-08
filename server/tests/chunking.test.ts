import { describe, it, expect } from 'vitest';
import { chunkDocument, estimateTokens } from '../src/services/documents/chunking.js';
import { getDocumentsConfig } from '../src/config/documents.config.js';
import type { ExtractionResult, ParagraphProvenance } from '../src/services/documents/extraction/index.js';

const config = getDocumentsConfig();

function makeExtraction(paragraphs: string[], pages?: number[]): ExtractionResult {
  const provs: ParagraphProvenance[] = paragraphs.map((text, i) => ({
    index: i,
    pageStart: pages ? pages[i] : null,
    pageEnd: pages ? pages[i] : null,
    heading: null,
    sectionPath: null,
    charStart: i * 100,
    charEnd: i * 100 + text.length,
  }));
  return {
    totalText: paragraphs.join('\n\n'),
    paragraphs: paragraphs.map((text, i) => ({
      text,
      provenance: provs[i],
      tokenEstimate: Math.max(1, Math.ceil(text.length / 4)),
    })),
    totalPages: pages ? Math.max(...pages) : null,
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
    expect(result.chunks[0].documentId).toBe('doc-1');
    expect(result.chunks[0].userId).toBe('user-1');
  });

  it('preserves page provenance', () => {
    const extraction = makeExtraction(
      ['Page one text.', 'Page two text.'],
      [1, 2],
    );
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    expect(result.chunks[0].pageStart).toBe(1);
    expect(result.chunks[0].pageEnd).toBe(2);
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
    expect(result.chunks[0].paragraphStart).toBe(0);
    expect(result.chunks[0].paragraphEnd).toBeGreaterThanOrEqual(0);
  });

  it('chunks have sequential indices', () => {
    const paragraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} with some content to fill space.`);
    const extraction = makeExtraction(paragraphs);
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    for (let i = 0; i < result.chunks.length; i++) {
      expect(result.chunks[i].chunkIndex).toBe(i);
    }
  });

  it('chunks have char offsets', () => {
    const extraction = makeExtraction(['Hello world.']);
    const result = chunkDocument('doc-1', 'user-1', extraction, config);
    expect(result.chunks[0].charStart).toBeGreaterThanOrEqual(0);
    expect(result.chunks[0].charEnd).toBeGreaterThan(result.chunks[0].charStart);
  });
});
