import { describe, it, expect } from 'vitest';
import { validateCitations, buildSourceMap } from '../src/services/documents/citation.service.js';
import type { DocumentSource } from '../../shared/types.js';

function makeSource(marker: string, docId: string = 'doc-1'): DocumentSource {
  return {
    marker,
    document_id: docId,
    chunk_id: `chunk-${marker}`,
    filename: 'guide.pdf',
    page: 4,
    heading: 'Skills',
    similarity: 0.9,
  };
}

describe('M5 Phase 9 citation validation', () => {
  it('validates markers against source map', () => {
    const sources = [makeSource('S1'), makeSource('S2')];
    const sourceMap = buildSourceMap(sources);
    const reply = 'According to [S1], Python is required. Also [S2] mentions SQL.';
    const result = validateCitations(reply, sourceMap);
    expect(result.validMarkers).toContain('S1');
    expect(result.validMarkers).toContain('S2');
    expect(result.invalidMarkers).toHaveLength(0);
    expect(result.sources).toHaveLength(2);
  });

  it('drops invented markers', () => {
    const sources = [makeSource('S1')];
    const sourceMap = buildSourceMap(sources);
    const reply = 'Claim [S1] and fake [S99].';
    const result = validateCitations(reply, sourceMap);
    expect(result.validMarkers).toContain('S1');
    expect(result.invalidMarkers).toContain('S99');
    expect(result.sources).toHaveLength(1);
  });

  it('handles no markers', () => {
    const sources = [makeSource('S1')];
    const sourceMap = buildSourceMap(sources);
    const reply = 'No citations here.';
    const result = validateCitations(reply, sourceMap);
    expect(result.validMarkers).toHaveLength(0);
    expect(result.invalidMarkers).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
  });

  it('deduplicates repeated markers', () => {
    const sources = [makeSource('S1')];
    const sourceMap = buildSourceMap(sources);
    const reply = 'Claim [S1] and again [S1].';
    const result = validateCitations(reply, sourceMap);
    expect(result.sources).toHaveLength(1);
  });

  it('sorts sources by marker number', () => {
    const sources = [makeSource('S3'), makeSource('S1'), makeSource('S2')];
    const sourceMap = buildSourceMap(sources);
    const reply = '[S3] [S1] [S2]';
    const result = validateCitations(reply, sourceMap);
    expect(result.sources[0].marker).toBe('S1');
    expect(result.sources[1].marker).toBe('S2');
    expect(result.sources[2].marker).toBe('S3');
  });

  it('handles empty source map', () => {
    const sourceMap = new Map<string, DocumentSource>();
    const reply = 'Claim [S1].';
    const result = validateCitations(reply, sourceMap);
    expect(result.invalidMarkers).toContain('S1');
    expect(result.sources).toHaveLength(0);
  });
});
