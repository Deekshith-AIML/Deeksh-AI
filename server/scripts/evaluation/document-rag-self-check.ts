/**
 * scripts/evaluation/document-rag-self-check.ts
 * ---------------------------------------------
 * Offline integrity checks for the Phase 12 corpus and query set.
 *
 * These run without a database, embeddings or model provider, so CI can prove
 * that the dataset is reproducible and that every hand-authored expected
 * anchor really exists in the synthetic corpus. A failure here means the
 * evaluation itself is unsound, not that retrieval quality changed.
 */

import {
  CORPUS,
  generateCorpus,
  normalizeForMatch,
  type CorpusDocument,
  type GeneratedDocument,
} from './document-rag-corpus.js';
import {
  QUERIES,
  queryCategoryCounts,
  type EvalQuery,
  type QueryCategory,
} from './document-rag-queries.js';

export interface DatasetCheckResult {
  ok: boolean;
  errors: string[];
  stats: {
    documents: number;
    formats: Record<string, number>;
    queries: number;
    categories: Record<QueryCategory, number>;
    scoredQueries: number;
    injectableDocs: number;
  };
}

const MIN_DOCUMENTS = 15;
const MIN_QUERIES = 50;

const REQUIRED_CATEGORIES: QueryCategory[] = [
  'exact',
  'semantic',
  'multi_document',
  'table',
  'section',
  'pdf_page',
  'contradictory',
  'unanswerable',
  'irrelevant',
  'prompt_injection',
];

function pageTexts(doc: CorpusDocument): string[] {
  if (!doc.pages) return [];
  return doc.pages.map((blocks) =>
    normalizeForMatch(
      blocks
        .map((block) =>
          block.type === 'table' ? block.rows.map((r) => r.join(' | ')).join(' ') : block.text,
        )
        .join(' '),
    ),
  );
}

function headingsOf(doc: CorpusDocument): string[] {
  const blocks = doc.blocks ?? doc.pages?.flat() ?? [];
  return blocks.filter((block) => block.type === 'heading').map((block) => block.text);
}

/** Every document that contains an anchor. */
function docsContainingAnchor(
  corpus: readonly GeneratedDocument[],
  anchor: string,
): GeneratedDocument[] {
  return corpus.filter((doc) => doc.normalizedText.includes(anchor));
}

export function checkDataset(): DatasetCheckResult {
  const errors: string[] = [];
  const stats: DatasetCheckResult['stats'] = {
    documents: CORPUS.length,
    formats: {},
    queries: QUERIES.length,
    categories: queryCategoryCounts(),
    scoredQueries: QUERIES.filter((q) => q.scored).length,
    injectableDocs: CORPUS.filter((doc) => doc.traits.includes('prompt-injection')).length,
  };

  for (const doc of CORPUS) {
    stats.formats[doc.format] = (stats.formats[doc.format] ?? 0) + 1;
  }

  if (CORPUS.length < MIN_DOCUMENTS) {
    errors.push(`Expected at least ${MIN_DOCUMENTS} documents, found ${CORPUS.length}.`);
  }
  if (QUERIES.length < MIN_QUERIES) {
    errors.push(`Expected at least ${MIN_QUERIES} queries, found ${QUERIES.length}.`);
  }

  // Format coverage.
  for (const format of ['pdf', 'docx', 'txt'] as const) {
    if ((stats.formats[format] ?? 0) === 0) {
      errors.push(`No ${format.toUpperCase()} document in the corpus.`);
    }
  }

  // Category coverage.
  for (const category of REQUIRED_CATEGORIES) {
    if (stats.categories[category] === 0) {
      errors.push(`No query in required category "${category}".`);
    }
  }

  // Uniqueness of document keys and query ids.
  const docKeys = new Set<string>();
  for (const doc of CORPUS) {
    if (docKeys.has(doc.key)) errors.push(`Duplicate document key: ${doc.key}`);
    docKeys.add(doc.key);
    if (!doc.key.startsWith('eval-doc-')) {
      errors.push(`Document key does not use the eval prefix: ${doc.key}`);
    }
  }
  const queryIds = new Set<string>();
  for (const query of QUERIES) {
    if (queryIds.has(query.id)) errors.push(`Duplicate query id: ${query.id}`);
    queryIds.add(query.id);
  }

  // Corpus text is generated asynchronously; the synchronous check below uses
  // the authored blocks. The async variant additionally verifies bytes.
  for (const query of QUERIES) {
    for (const key of query.expectedDocKeys) {
      if (!docKeys.has(key)) {
        errors.push(`Query ${query.id} references unknown document ${key}.`);
      }
    }

    const authored = CORPUS.map((doc) => ({
      key: doc.key,
      text: normalizeForMatch(
        (doc.blocks ?? doc.pages?.flat() ?? [])
          .map((block) =>
            block.type === 'table' ? block.rows.map((r) => r.join(' | ')).join(' ') : block.text,
          )
          .join(' '),
      ),
    }));

    for (const anchor of query.expectedAnchors) {
      const matches = authored.filter((doc) => doc.text.includes(anchor));
      if (matches.length !== 1) {
        errors.push(
          `Query ${query.id} anchor "${anchor}" must appear in exactly one document (found ${matches.length}).`,
        );
      }
      const expected = matches[0];
      if (expected && query.expectedDocKeys.length > 0 && !query.expectedDocKeys.includes(expected.key)) {
        errors.push(
          `Query ${query.id} anchor "${anchor}" is in ${expected.key}, not in expectedDocKeys.`,
        );
      }
    }

    if (query.expectedAnchors.length > 0 && query.expectedDocKeys.length === 0) {
      errors.push(`Query ${query.id} has anchors but no expectedDocKeys.`);
    }

    if (query.scored && query.expectedAnchors.length === 0) {
      errors.push(`Scored query ${query.id} has no expected anchors.`);
    }

    if (query.category === 'pdf_page' && typeof query.expectedPage !== 'number') {
      errors.push(`PDF-page query ${query.id} has no expectedPage.`);
    }

    if (query.category === 'section' && !query.expectedHeading) {
      errors.push(`Section query ${query.id} has no expectedHeading.`);
    }

    const primaryDoc = CORPUS.find((doc) => doc.key === query.expectedDocKeys[0]);
    if (query.expectedPage !== undefined && primaryDoc) {
      const pages = pageTexts(primaryDoc);
      const page = pages[query.expectedPage - 1];
      if (page === undefined) {
        errors.push(
          `Query ${query.id} expects page ${query.expectedPage}, but ${primaryDoc.key} has ${pages.length} pages.`,
        );
      } else if (query.expectedAnchors[0] && !page.includes(query.expectedAnchors[0])) {
        errors.push(
          `Query ${query.id} anchor "${query.expectedAnchors[0]}" is not on page ${query.expectedPage}.`,
        );
      }
    }

    if (query.expectedHeading && primaryDoc) {
      const headings = headingsOf(primaryDoc);
      if (!headings.includes(query.expectedHeading)) {
        errors.push(
          `Query ${query.id} expects heading "${query.expectedHeading}", which is not a heading in ${primaryDoc.key}.`,
        );
      }
    }
  }

  // Prompt-injection fixtures must actually contain an instruction.
  const injectionDocs = CORPUS.filter((doc) => doc.traits.includes('prompt-injection'));
  if (injectionDocs.length === 0) {
    errors.push('No prompt-injection fixture in the corpus.');
  }
  for (const doc of injectionDocs) {
    const text = (doc.blocks ?? [])
      .map((block) => (block.type === 'table' ? '' : block.text))
      .join(' ');
    if (!/ignore previous instructions/i.test(text)) {
      errors.push(`Prompt-injection fixture ${doc.key} has no injection instruction.`);
    }
  }

  return { ok: errors.length === 0, errors, stats };
}

/**
 * Async variant that generates the real bytes (PDF/DOCX/TXT) and re-checks
 * every anchor against the generated plain text. Used by the evaluation script
 * and the test suite.
 */
export async function checkDatasetWithBytes(): Promise<DatasetCheckResult> {
  const result = checkDataset();
  const generated = await generateCorpus();

  for (const doc of generated) {
    if (doc.bytes.length === 0) {
      result.errors.push(`Generated document ${doc.key} is empty.`);
    }
  }

  for (const query of QUERIES) {
    for (const anchor of query.expectedAnchors) {
      const matches = docsContainingAnchor(generated, anchor);
      if (matches.length !== 1) {
        result.errors.push(
          `Generated corpus: query ${query.id} anchor "${anchor}" matched ${matches.length} documents.`,
        );
      }
    }
  }

  result.ok = result.errors.length === 0;
  return result;
}

export function assertDatasetSound(): void {
  const check = checkDataset();
  if (!check.ok) {
    throw new Error(`Document RAG dataset is unsound:\n- ${check.errors.join('\n- ')}`);
  }
}
