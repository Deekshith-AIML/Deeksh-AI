/**
 * services/embedding.service.ts
 * -----------------------------
 * Dedicated embedding-provider abstraction (Milestone 4.1 — Tasks A/B).
 *
 * Primary:  Gemini `gemini-embedding-2` via the OFFICIAL REST endpoint
 *           `POST /v1beta/models/{model}:embedContent` with
 *           `output_dimensionality: 1536` (the model defaults to 3072 —
 *           without this field the response would fail our dimension lock).
 *           Sources inspected 2026-11: ai.google.dev/gemini-api/docs/embeddings
 *           and ai.google.dev/api/embeddings.
 * Isolated: Ollama `embeddinggemma` via `POST /api/embed` (native 768 dims —
 *           a DIFFERENT vector space; it can never serve the 1536-dim
 *           searchable index and is evaluated in isolation only).
 *
 * Rules enforced here:
 * - One active embedding model per searchable index: provider/model/dimension
 *   metadata plus explicit space-compatibility checks. NEVER silent padding
 *   or truncation of vectors — incompatibility raises a typed error.
 * - `task_type` is NOT supported by `gemini-embedding-2` (official docs), so
 *   the task is carried as a prompt instruction, applied consistently on both
 *   sides of retrieval (asymmetric format from the official docs):
 *       query:    `task: search result | query: {text}`
 *       document: `title: none | text: {text}`
 * - Typed error codes: auth, rate-limit, quota, timeout, network,
 *   invalid-request, model-not-found, bad-response, dimension-mismatch,
 *   space-mismatch, empty-input, unknown-provider.
 * - API keys are sent ONLY in the `x-goog-api-key` header (never in a URL),
 *   and error messages are redacted + truncated — credentials and memory
 *   content are never logged by this module.
 * - Mock embeddings (deterministic, 1536 dims) keep the regression suite
 *   offline: `embed()` short-circuits when NODE_ENV=test or opts.mock=true.
 */

import { z } from 'zod';

/** Searchable index dimension lock (vector(1536) in 0005_memory_engine.sql). */
export const EMBEDDING_DIMENSION = 1536;
export const EMBEDDING_PROVIDER_DEFAULT = 'gemini';
export const GEMINI_EMBED_MODEL = 'gemini-embedding-2';
export const OLLAMA_EMBED_MODEL = 'embeddinggemma';
/** embeddinggemma native output (MRL-capable 768; NOT compatible with 1536). */
export const OLLAMA_EMBED_DIMENSION = 768;
/** Gemini is a warm cloud API — 30s is generous. */
export const GEMINI_TIMEOUT_MS_DEFAULT = 30_000;
/** Ollama loads the model into memory on FIRST use (observed ~40–55s cold). */
export const OLLAMA_TIMEOUT_MS_DEFAULT = 120_000;

export type EmbeddingProvider = 'gemini' | 'ollama';
export type EmbeddingRole = 'query' | 'document';

export type EmbeddingErrorCode =
  | 'NO_KEY'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'QUOTA'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'INVALID_REQUEST'
  | 'MODEL_NOT_FOUND'
  | 'BAD_RESPONSE'
  | 'DIM_MISMATCH'
  | 'SPACE_MISMATCH'
  | 'EMPTY_INPUT'
  | 'UNKNOWN_PROVIDER'
  | 'FAIL';

export class EmbeddingServiceError extends Error {
  constructor(message: string, public readonly code?: EmbeddingErrorCode) {
    super(message);
    this.name = 'EmbeddingServiceError';
  }
}

/** Identity of an embedding space: provider + model + dimension. */
export interface EmbeddingSpace {
  provider: EmbeddingProvider;
  model: string;
  /** 0 = runtime-determined (Ollama models other than embeddinggemma). */
  dimension: number;
}

/** Result of a live embedding call including space metadata. */
export interface EmbeddingResult {
  vector: number[];
  provider: EmbeddingProvider;
  model: string;
  dimension: number;
}

// ---------------------------------------------------------------------------
// Redaction (never leak keys, even inside provider error bodies)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = /(AIza[0-9A-Za-z_-]{8,}|sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g;

/**
 * Redact credential-shaped strings and bound the length of any message.
 * Also redacts the EXACT configured credential values (covers key formats
 * that do not match the well-known shapes above).
 */
export function redactSecrets(input: string, maxLen = 300): string {
  let out = String(input);
  for (const name of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'SUPABASE_ANON_KEY'] as const) {
    const v = process.env[name];
    if (v && v.length >= 8) out = out.split(v).join('[redacted]');
  }
  return out.replace(SECRET_PATTERNS, '[redacted]').slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Mock (offline tests only)
// ---------------------------------------------------------------------------

function mockEmbedding(text: string): number[] {
  // Deterministic mock for tests: 1536 dims, same input → same output (approx)
  // Not cryptographically secure; sufficient for automated retrieval quality checks.
  const seed = text.length % 100;
  const arr = new Array(EMBEDDING_DIMENSION).fill(0);
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    arr[i] = Math.sin(i * 0.1 + seed * 0.01) * 0.5 + 0.5;
  }
  // Normalize roughly
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0)) || 1;
  return arr.map((v) => v / norm);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface EmbeddingConfig {
  provider: EmbeddingProvider;
  geminiModel: string;
  geminiApiKey?: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  /** Explicit EMBEDDING_TIMEOUT_MS override; 0 = provider defaults apply. */
  timeoutMs: number;
}

/**
 * Resolve embedding configuration from the environment at call time.
 * Empty strings fall back to defaults (`.env.example` documents
 * `GEMINI_EMBEDDING_MODEL=` as "leave empty for gemini-embedding-2").
 */
export function resolveEmbeddingConfig(): EmbeddingConfig {
  const raw = (process.env.EMBEDDING_PROVIDER || EMBEDDING_PROVIDER_DEFAULT).trim().toLowerCase();
  if (raw !== 'gemini' && raw !== 'ollama') {
    throw new EmbeddingServiceError(
      `Unknown EMBEDDING_PROVIDER "${redactSecrets(raw, 40)}" (expected "gemini" or "ollama").`,
      'UNKNOWN_PROVIDER',
    );
  }
  const timeoutRaw = Number(process.env.EMBEDDING_TIMEOUT_MS);
  return {
    provider: raw,
    geminiModel: process.env.GEMINI_EMBEDDING_MODEL?.trim() || GEMINI_EMBED_MODEL,
    geminiApiKey: process.env.GEMINI_API_KEY || undefined,
    ollamaBaseUrl: (
      process.env.OLLAMA_BASE_URL ||
      process.env.OLLAMA_URL || // legacy M4 name, kept for compatibility
      'http://localhost:11434'
    ).replace(/\/+$/, ''),
    ollamaModel:
      process.env.OLLAMA_EMBEDDING_MODEL?.trim() ||
      process.env.OLLAMA_EMBED_MODEL?.trim() || // legacy M4 name
      OLLAMA_EMBED_MODEL,
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 0,
  };
}

/** Expected Ollama dimension for a known model (0 = unknown/runtime). */
function expectedOllamaDimension(model: string): number {
  return model.split(':')[0] === OLLAMA_EMBED_MODEL ? OLLAMA_EMBED_DIMENSION : 0;
}

/** The ONE active embedding space of the searchable index (from config). */
export function getActiveSpace(): EmbeddingSpace {
  const cfg = resolveEmbeddingConfig();
  if (cfg.provider === 'gemini') {
    return { provider: 'gemini', model: cfg.geminiModel, dimension: EMBEDDING_DIMENSION };
  }
  return { provider: 'ollama', model: cfg.ollamaModel, dimension: expectedOllamaDimension(cfg.ollamaModel) };
}

// ---------------------------------------------------------------------------
// Prompt formatting (official asymmetric retrieval format for embedding-2)
// ---------------------------------------------------------------------------

/**
 * gemini-embedding-2 does NOT accept `task_type`; the official docs require
 * the task to be an instruction inside the prompt, used consistently for
 * queries and documents. Ollama inputs are passed through unmodified —
 * its vector space is separate and never mixed with Gemini's.
 */
export function formatEmbeddingText(text: string, role: EmbeddingRole, provider: EmbeddingProvider): string {
  if (provider !== 'gemini') return text;
  return role === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
}

// ---------------------------------------------------------------------------
// Space compatibility (never mix vector spaces)
// ---------------------------------------------------------------------------

/**
 * Two spaces are compatible only with identical provider+model and, when
 * both dimensions are known, identical dimensions. Dimension 0 means
 * "runtime-determined" and defers to the provider's own validation.
 */
export function spacesCompatible(a: EmbeddingSpace, b: EmbeddingSpace): boolean {
  if (a.provider !== b.provider || a.model !== b.model) return false;
  if (a.dimension > 0 && b.dimension > 0 && a.dimension !== b.dimension) return false;
  return true;
}

/**
 * Refuse to write a vector into the searchable index when it does not belong
 * to the active space, or when the active space itself cannot serve the
 * vector(1536) index. Never pads/truncates — raises SPACE_MISMATCH so the
 * caller can use a controlled re-embedding migration or an isolated index.
 */
export function assertStorableInIndex(result: EmbeddingResult, active: EmbeddingSpace = getActiveSpace()): void {
  const produced: EmbeddingSpace = { provider: result.provider, model: result.model, dimension: result.dimension };
  if (!spacesCompatible(produced, active)) {
    throw new EmbeddingServiceError(
      `Embedding space mismatch: produced ${produced.provider}/${produced.model}/${produced.dimension} ` +
        `but the active index space is ${active.provider}/${active.model}/${active.dimension}. ` +
        `Switching providers requires a controlled re-embedding migration or an isolated index — ` +
        `vectors are never padded or truncated.`,
      'SPACE_MISMATCH',
    );
  }
  if (produced.dimension !== EMBEDDING_DIMENSION) {
    throw new EmbeddingServiceError(
      `Active embedding dimension ${produced.dimension} does not match the searchable index ` +
        `dimension ${EMBEDDING_DIMENSION}. Evaluate alternative models in an isolated index — ` +
        `vectors are never padded or truncated.`,
      'SPACE_MISMATCH',
    );
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertFinite(values: number[], label: string): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new EmbeddingServiceError(
        `${label} embedding contains a non-finite value at index ${i} (NaN/Infinity).`,
        'BAD_RESPONSE',
      );
    }
  }
}

function mapNetworkError(err: unknown, label: string): EmbeddingServiceError {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new EmbeddingServiceError(`${label} embedding request timed out.`, 'TIMEOUT');
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new EmbeddingServiceError(`${label} embedding request failed: ${redactSecrets(msg, 200)}`, 'NETWORK');
}

/** Classify a non-2xx provider response into a typed error (redacted). */
async function httpError(res: Response, provider: EmbeddingProvider): Promise<EmbeddingServiceError> {
  const status = res.status;
  let detail = '';
  try {
    const body = await res.text();
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
    detail = String(parsed?.error?.message ?? parsed?.message ?? '').slice(0, 300);
  } catch {
    // Non-JSON error body — status alone is used below.
  }
  detail = redactSecrets(detail);

  const quotaish = /quota|resource[\s_]*exhausted|exhausted/i.test(detail);
  const badKey = /api[\s_-]*key/i.test(detail);

  let code: EmbeddingErrorCode;
  if (status === 401 || status === 403 || (status === 400 && badKey)) code = 'AUTH';
  else if (status === 429) code = quotaish ? 'QUOTA' : 'RATE_LIMIT';
  else if (status === 408 || status === 504) code = 'TIMEOUT';
  else if (status === 404) code = 'MODEL_NOT_FOUND';
  else if (status === 400 || status === 413 || status === 414) code = 'INVALID_REQUEST';
  else if (status >= 500) code = 'FAIL';
  else code = 'BAD_RESPONSE';

  const label = provider === 'gemini' ? 'Gemini' : 'Ollama';
  return new EmbeddingServiceError(`${label} embed HTTP ${status}${detail ? `: ${detail}` : ''}`, code);
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function embedGemini(text: string, role: EmbeddingRole, cfg: EmbeddingConfig): Promise<number[]> {
  const key = cfg.geminiApiKey;
  if (!key) throw new EmbeddingServiceError('GEMINI_API_KEY is not configured for embeddings.', 'NO_KEY');

  const prompt = formatEmbeddingText(text, role, 'gemini');
  const timeoutMs = cfg.timeoutMs || GEMINI_TIMEOUT_MS_DEFAULT;
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:embedContent`,
      {
        method: 'POST',
        // Key travels ONLY in this header — never in the URL (headers/URLs get logged).
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          content: { parts: [{ text: prompt }] },
          // gemini-embedding-2 defaults to 3072 dims; the index is locked at 1536.
          output_dimensionality: EMBEDDING_DIMENSION,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (err) {
    throw mapNetworkError(err, 'Gemini');
  }
  if (!res.ok) throw await httpError(res, 'gemini');

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new EmbeddingServiceError('Gemini returned a non-JSON response.', 'BAD_RESPONSE');
  }
  const values = (data as { embedding?: { values?: unknown } })?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new EmbeddingServiceError('Gemini response is missing embedding.values.', 'BAD_RESPONSE');
  }
  if (values.length !== EMBEDDING_DIMENSION) {
    throw new EmbeddingServiceError(
      `Gemini embedding dimension mismatch: expected ${EMBEDDING_DIMENSION}, got ${values.length}.`,
      'DIM_MISMATCH',
    );
  }
  assertFinite(values as number[], 'Gemini');
  return values as number[];
}

async function embedOllama(text: string, cfg: EmbeddingConfig): Promise<number[]> {
  // First request after boot/pull loads the model into memory (cold start can
  // take ~40–55s on a desktop) — hence the generous default over Gemini's.
  const timeoutMs = cfg.timeoutMs || OLLAMA_TIMEOUT_MS_DEFAULT;
  let res: Response;
  try {
    res = await fetch(`${cfg.ollamaBaseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.ollamaModel, input: text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw mapNetworkError(err, 'Ollama');
  }
  if (!res.ok) throw await httpError(res, 'ollama');

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new EmbeddingServiceError('Ollama returned a non-JSON response.', 'BAD_RESPONSE');
  }
  // Official contract: { model, embeddings: [ [ ... ], ... ] } — array OF arrays.
  const embeddings = (data as { embeddings?: unknown })?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length === 0 || !Array.isArray(embeddings[0])) {
    throw new EmbeddingServiceError('Ollama response is missing embeddings[0] (expected number[][]).', 'BAD_RESPONSE');
  }
  const vector = embeddings[0] as number[];
  if (vector.length === 0) {
    throw new EmbeddingServiceError('Ollama returned an empty embedding vector.', 'BAD_RESPONSE');
  }
  const expected = expectedOllamaDimension(cfg.ollamaModel);
  if (expected > 0 && vector.length !== expected) {
    throw new EmbeddingServiceError(
      `Ollama embedding dimension mismatch: ${cfg.ollamaModel} should produce ${expected}, got ${vector.length}.`,
      'DIM_MISMATCH',
    );
  }
  assertFinite(vector, 'Ollama');
  return vector;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed text through the configured provider WITHOUT the test mock —
 * used by live smoke tests and by `embed()` outside the test environment.
 * Validates response shape, dimensions and finiteness; throws typed
 * EmbeddingServiceErrors. Never logs keys or input content.
 */
export async function embedWithMeta(
  text: string,
  opts?: { provider?: EmbeddingProvider; role?: EmbeddingRole },
): Promise<EmbeddingResult> {
  const cfg = resolveEmbeddingConfig();
  const provider = opts?.provider ?? cfg.provider;
  const role: EmbeddingRole = opts?.role ?? 'document';

  if (!text || !text.trim()) {
    throw new EmbeddingServiceError('Cannot embed empty input.', 'EMPTY_INPUT');
  }

  let vector: number[];
  let model: string;
  if (provider === 'gemini') {
    vector = await embedGemini(text, role, cfg);
    model = cfg.geminiModel;
  } else if (provider === 'ollama') {
    vector = await embedOllama(text, cfg);
    model = cfg.ollamaModel;
  } else {
    throw new EmbeddingServiceError(`Unknown embedding provider "${String(provider)}".`, 'UNKNOWN_PROVIDER');
  }

  return { vector, provider, model, dimension: vector.length };
}

/**
 * Generate an embedding for text (public entry point).
 * Tests (NODE_ENV=test) and opts.mock get the deterministic offline mock —
 * the normal regression suite NEVER performs live API calls.
 */
export async function embed(
  text: string,
  opts?: { provider?: EmbeddingProvider; mock?: boolean; role?: EmbeddingRole },
): Promise<number[]> {
  if (opts?.mock || process.env.NODE_ENV === 'test') {
    return mockEmbedding(text);
  }
  return (await embedWithMeta(text, opts)).vector;
}

/** Schema for embedding input (used by extraction service). */
export const embeddingInputSchema = z.object({
  text: z.string().min(1).max(8000),
  provider: z.enum(['gemini', 'ollama']).optional(),
  role: z.enum(['query', 'document']).optional(),
});
