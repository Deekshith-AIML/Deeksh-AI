/**
 * tests/citation-link.test.ts
 * ---------------------------
 * Pure citation → viewer navigation rules shared by the frontend.
 *
 * These assertions pin the provenance contract:
 * - PDF citations carry the real extracted page.
 * - DOCX citations carry a heading and never a page.
 * - TXT citations carry the chunk id used to resolve paragraph provenance.
 * - Missing/invalid page values never become an invented page 1.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDocumentCitationHref,
  parseDocumentViewerTarget,
  pdfPageFragment,
} from '../../shared/citation-link.js';

const DOC = '11111111-1111-4111-8111-111111111111';
const CHUNK = '22222222-2222-4222-8222-222222222222';

describe('M5 corrective patch 3 — citation navigation', () => {
  it('opens the cited PDF page with real page numbering', () => {
    const href = buildDocumentCitationHref({
      document_id: DOC,
      chunk_id: CHUNK,
      page: 4,
      heading: 'Skills',
    });
    expect(href).toBe(
      `/documents/${DOC}?page=4&chunk=${CHUNK}&heading=Skills`,
    );
    expect(pdfPageFragment(4)).toBe('#page=4');
  });

  it('uses a DOCX heading/section and never invents a page', () => {
    const href = buildDocumentCitationHref({
      document_id: DOC,
      chunk_id: CHUNK,
      page: null,
      heading: 'Experience > Projects',
    });
    expect(href).toContain(`/documents/${DOC}?`);
    expect(href).toContain('heading=Experience+%3E+Projects');
    expect(href).not.toContain('page=');
    expect(pdfPageFragment(null)).toBe('');
  });

  it('locates a TXT citation by chunk id for paragraph provenance', () => {
    const href = buildDocumentCitationHref({
      document_id: DOC,
      chunk_id: CHUNK,
      page: null,
      heading: null,
    });
    expect(href).toBe(`/documents/${DOC}?chunk=${CHUNK}`);
  });

  it('handles missing page metadata safely', () => {
    const href = buildDocumentCitationHref({
      document_id: DOC,
      chunk_id: CHUNK,
      page: null,
      heading: null,
    });
    expect(href).not.toContain('page=');
    expect(pdfPageFragment(null)).toBe('');
  });

  it('rejects invalid and non-positive page values', () => {
    for (const page of [0, -3, 1.5, Number.NaN]) {
      const href = buildDocumentCitationHref({
        document_id: DOC,
        page,
        heading: null,
      });
      expect(href).not.toContain('page=');
    }

    const target = parseDocumentViewerTarget({
      page: 'not-a-number',
      chunk: '   ',
      heading: '  ',
    });
    expect(target).toEqual({ page: null, chunkId: null, heading: null });
  });

  it('parses valid viewer parameters and first array values', () => {
    expect(
      parseDocumentViewerTarget({
        page: ['3', '9'],
        chunk: [CHUNK, 'ignored'],
        heading: ['Skills', 'ignored'],
      }),
    ).toEqual({ page: 3, chunkId: CHUNK, heading: 'Skills' });
  });

  it('does not expose storage paths or absolute URLs', () => {
    const href = buildDocumentCitationHref({
      document_id: DOC,
      chunk_id: CHUNK,
      page: 2,
      heading: 'Summary',
    });
    expect(href.startsWith('/documents/')).toBe(true);
    expect(href).not.toContain('storage');
    expect(href).not.toContain('http');
  });
});
