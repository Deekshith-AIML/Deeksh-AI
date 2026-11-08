/**
 * services/documents/citation.service.ts
 * -------------------------------------
 * Citation validation for RAG answers (Milestone 5).
 *
 * The model is instructed to emit `[S#]` markers. This module:
 *   1. Parses all `[S\d+]` markers from the reply.
 *   2. Validates each against the supplied source map (only markers that
 *      map to a real retrieved chunk are kept).
 *   3. Returns the list of resolvable sources (in marker order, deduped).
 *   4. Returns the count of dropped (invented) markers for observability.
 *
 * Invented markers are silently dropped — never returned as citations.
 */

import type { DocumentSource } from '../../../../shared/types.js';

export interface CitationValidationResult {
  /** Markers that resolved to real sources. */
  validMarkers: string[];
  /** Markers the model invented (not in the source map). */
  invalidMarkers: string[];
  /** Sources in marker order, deduplicated. */
  sources: DocumentSource[];
}

/**
 * Validate citation markers against a source map.
 *
 * @param reply       The model's reply text.
 * @param sourceMap   Map from marker (e.g. "S1") to DocumentSource.
 */
export function validateCitations(
  reply: string,
  sourceMap: Map<string, DocumentSource>,
): CitationValidationResult {
  const markerRegex = /\[S(\d+)\]/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = markerRegex.exec(reply)) !== null) {
    found.add(`S${match[1]}`);
  }

  const validMarkers: string[] = [];
  const invalidMarkers: string[] = [];
  const sources: DocumentSource[] = [];
  const seen = new Set<string>();

  for (const marker of found) {
    const source = sourceMap.get(marker);
    if (source) {
      validMarkers.push(marker);
      if (!seen.has(marker)) {
        seen.add(marker);
        sources.push(source);
      }
    } else {
      invalidMarkers.push(marker);
    }
  }

  // Sort by marker number for stable ordering.
  sources.sort((a, b) => {
    const na = parseInt(a.marker.replace('S', ''), 10);
    const nb = parseInt(b.marker.replace('S', ''), 10);
    return na - nb;
  });

  return { validMarkers, invalidMarkers, sources };
}

/**
 * Build a source map from an array of DocumentSource objects.
 */
export function buildSourceMap(sources: DocumentSource[]): Map<string, DocumentSource> {
  const map = new Map<string, DocumentSource>();
  for (const s of sources) {
    map.set(s.marker, s);
  }
  return map;
}