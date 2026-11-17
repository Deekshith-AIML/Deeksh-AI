/**
 * config/documents.config.ts
 * --------------------------
 * Central configuration for the Knowledge Base (Milestone 5).
 *
 * Everything is environment-overridable but has a safe default, so the
 * feature works without touching any `.env` file. Values are read lazily
 * (per call) so tests can override `process.env` without module reloads.
 *
 * SECURITY: these are server-side only. Nothing here is ever sent to the
 * browser, and no secret is read from this module.
 */

export interface DocumentsConfig {
  /** Hard upload cap in bytes (default 25 MiB). */
  maxUploadBytes: number;
  /** Private storage bucket name. */
  bucket: string;
  /** Storage implementation. `local` is a development-only adapter. */
  storageProvider: 'supabase' | 'local';
  /** Root directory for the local adapter. */
  localStorageDir: string;

  /** Chunking: target tokens per chunk. */
  chunkTargetTokens: number;
  /** Chunking: overlapping tokens carried into the next chunk. */
  chunkOverlapTokens: number;
  /** Hard cap on chunks per document. */
  maxChunksPerDocument: number;
  /** Hard cap on extracted characters per document. */
  maxTextChars: number;

  /** Minimum document similarity accepted by retrieval. */
  retrievalThreshold: number;
  /** Top-K for explicit Knowledge Base search. */
  retrievalTopK: number;
  /** Top-K chunks injected per chat turn. */
  chatTopK: number;
  /** Character budget for the document context block. */
  maxContextChars: number;
  /** Bounded concurrency for chunk embedding. */
  embedConcurrency: number;

  /** Per-document extraction timeout. */
  extractionTimeoutMs: number;
  /** Below this many extracted characters a PDF is treated as scanned. */
  minExtractableChars: number;

  /** DOCX (ZIP) resource guards. */
  docxMaxEntries: number;
  docxMaxUncompressedBytes: number;
  /** Maximum declared uncompressed size for any single ZIP entry. */
  docxMaxEntryUncompressedBytes: number;
  docxMaxCompressionRatio: number;
  /** Wall-clock budget for the bounded DOCX ZIP inspection. */
  docxInspectionTimeoutMs: number;

  /** Per-user, per-instance rate limits. */
  uploadRatePerMin: number;
  searchRatePerMin: number;

  /** Worker polling interval. */
  workerIntervalMs: number;
  /** Jobs claimed per tick. */
  workerBatchSize: number;
  /** Base delay for exponential retry backoff. */
  retryBaseDelayMs: number;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function floatEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function getDocumentsConfig(): DocumentsConfig {
  const provider = process.env.STORAGE_PROVIDER === 'local' ? 'local' : 'supabase';
  return {
    maxUploadBytes: intEnv('MAX_UPLOAD_BYTES', 26_214_400, 1, 104_857_600),
    bucket: process.env.DOCUMENTS_BUCKET?.trim() || 'documents',
    storageProvider: provider,
    localStorageDir:
      process.env.LOCAL_STORAGE_DIR?.trim() || 'server/.local-storage',

    chunkTargetTokens: intEnv('DOC_CHUNK_TARGET_TOKENS', 900, 100, 8000),
    chunkOverlapTokens: intEnv('DOC_CHUNK_OVERLAP_TOKENS', 120, 0, 2000),
    maxChunksPerDocument: intEnv('DOC_MAX_CHUNKS_PER_DOCUMENT', 2000, 1, 50_000),
    maxTextChars: intEnv('DOC_MAX_TEXT_CHARS', 2_000_000, 1000, 20_000_000),

    retrievalThreshold: floatEnv('DOC_RETRIEVAL_THRESHOLD', 0.5, 0, 1),
    retrievalTopK: intEnv('DOC_RETRIEVAL_TOP_K', 8, 1, 50),
    chatTopK: intEnv('DOC_CHAT_TOP_K', 6, 1, 20),
    maxContextChars: intEnv('DOC_MAX_CONTEXT_CHARS', 6000, 500, 40_000),
    embedConcurrency: intEnv('DOC_EMBED_CONCURRENCY', 3, 1, 10),

    extractionTimeoutMs: intEnv('EXTRACTION_TIMEOUT_MS', 30_000, 1000, 300_000),
    minExtractableChars: intEnv('DOC_MIN_EXTRACTABLE_CHARS', 50, 0, 10_000),

    docxMaxEntries: intEnv('DOCX_MAX_ENTRIES', 2000, 10, 100_000),
    docxMaxUncompressedBytes: intEnv(
      'DOCX_MAX_UNCOMPRESSED_BYTES',
      209_715_200,
      1_048_576,
      1_073_741_824,
    ),
    docxMaxEntryUncompressedBytes: intEnv(
      'DOCX_MAX_ENTRY_UNCOMPRESSED_BYTES',
      52_428_800,
      1_048_576,
      1_073_741_824,
    ),
    docxMaxCompressionRatio: intEnv('DOCX_MAX_COMPRESSION_RATIO', 100, 1, 10_000),
    docxInspectionTimeoutMs: intEnv('DOCX_INSPECTION_TIMEOUT_MS', 5000, 100, 120_000),

    uploadRatePerMin: intEnv('DOC_RATE_LIMIT_UPLOADS_PER_MIN', 10, 1, 600),
    searchRatePerMin: intEnv('DOC_RATE_LIMIT_SEARCHES_PER_MIN', 60, 1, 6000),

    workerIntervalMs: intEnv('DOC_WORKER_INTERVAL_MS', 5000, 250, 300_000),
    workerBatchSize: intEnv('DOC_WORKER_BATCH_SIZE', 3, 1, 20),
    retryBaseDelayMs: intEnv('DOC_RETRY_BASE_DELAY_MS', 5000, 100, 600_000),
  };
}

/** Bounded exponential backoff for a given attempt count (1-based). */
export function retryDelayMs(attempts: number, baseMs: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 6);
  const delay = baseMs * Math.pow(2, exponent);
  // +/- 10% jitter so retries do not synchronise across workers.
  const jitter = delay * 0.1 * Math.random();
  return Math.round(Math.min(delay + jitter, 10 * 60_000));
}
