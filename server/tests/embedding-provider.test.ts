/**
 * tests/embedding-provider.test.ts
 * --------------------------------
 * Milestone 4.1 — Task A/B: embedding provider abstraction tests.
 *
 * All provider tests stub global `fetch` — the normal regression suite NEVER
 * performs live API calls (live checks are explicit opt-in smoke scripts).
 *
 * Covered:
 * - Gemini provider request/response contract (endpoint, output_dimensionality,
 *   x-goog-api-key header, asymmetric task prefixes).
 * - Ollama /api/embed contract (array-of-arrays response, model name).
 * - Typed error handling: auth, rate limit, quota, timeout, network,
 *   invalid request, model not found, bad response, dimension mismatch,
 *   empty input, missing key.
 * - Dimension validation (1536 lock / 768 embeddinggemma) and finiteness
 *   (NaN/Infinity rejection).
 * - Embedding-space compatibility (never mix provider/model/dimension).
 * - Offline mock path preserved for the rest of the suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  embed,
  embedWithMeta,
  formatEmbeddingText,
  getActiveSpace,
  resolveEmbeddingConfig,
  spacesCompatible,
  assertStorableInIndex,
  redactSecrets,
  EmbeddingServiceError,
  EMBEDDING_DIMENSION,
  GEMINI_EMBED_MODEL,
  OLLAMA_EMBED_MODEL,
  OLLAMA_EMBED_DIMENSION,
} from '../src/services/embedding.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(status: number, raw: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(raw),
    text: async () => raw,
  } as unknown as Response;
}

function vector(n: number, fill = 0.25): number[] {
  return new Array(n).fill(fill);
}

function lastRequest(): { url: string; init: RequestInit } {
  const calls = fetchMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const call = calls[calls.length - 1];
  if (!call) throw new Error('fetch was not called');
  const [url, init] = call;
  return { url: String(url), init: init as RequestInit };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key-not-a-real-secret');
  vi.stubEnv('EMBEDDING_PROVIDER', 'gemini');
  vi.stubEnv('GEMINI_EMBEDDING_MODEL', '');
  vi.stubEnv('OLLAMA_BASE_URL', 'http://localhost:11434');
  vi.stubEnv('OLLAMA_EMBEDDING_MODEL', 'embeddinggemma');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Configuration, formatting, space compatibility
// ---------------------------------------------------------------------------

describe('embedding config and active space', () => {
  it('defaults to gemini / gemini-embedding-2 / 1536', () => {
    expect(resolveEmbeddingConfig().provider).toBe('gemini');
    expect(resolveEmbeddingConfig().geminiModel).toBe(GEMINI_EMBED_MODEL);
    expect(getActiveSpace()).toEqual({ provider: 'gemini', model: 'gemini-embedding-2', dimension: 1536 });
  });

  it('EMBEDDING_PROVIDER=ollama selects embeddinggemma at its native 768 dims', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'ollama');
    expect(getActiveSpace()).toEqual({ provider: 'ollama', model: 'embeddinggemma', dimension: OLLAMA_EMBED_DIMENSION });
    expect(OLLAMA_EMBED_DIMENSION).toBe(768);
  });

  it('never uses mistral as an embedding model', () => {
    expect(GEMINI_EMBED_MODEL).not.toContain('mistral');
    expect(OLLAMA_EMBED_MODEL).not.toContain('mistral');
  });

  it('rejects an unknown EMBEDDING_PROVIDER with a typed error', () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'cohere');
    expect(() => resolveEmbeddingConfig()).toThrowError(
      expect.objectContaining({ name: 'EmbeddingServiceError', code: 'UNKNOWN_PROVIDER' }),
    );
  });

  it('uses OLLAMA_BASE_URL (M4.1 name) and falls back to legacy OLLAMA_URL', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://host.docker.internal:11434/');
    expect(resolveEmbeddingConfig().ollamaBaseUrl).toBe('http://host.docker.internal:11434');
    vi.stubEnv('OLLAMA_BASE_URL', '');
    vi.stubEnv('OLLAMA_URL', 'http://legacy:11434');
    expect(resolveEmbeddingConfig().ollamaBaseUrl).toBe('http://legacy:11434');
  });
});

describe('prompt formatting (official asymmetric retrieval format)', () => {
  it('formats gemini queries and documents per official docs', () => {
    expect(formatEmbeddingText('What is my goal?', 'query', 'gemini')).toBe(
      'task: search result | query: What is my goal?',
    );
    expect(formatEmbeddingText('Preparing for placements.', 'document', 'gemini')).toBe(
      'title: none | text: Preparing for placements.',
    );
  });

  it('passes Ollama input through unchanged (separate vector space)', () => {
    expect(formatEmbeddingText('hello', 'query', 'ollama')).toBe('hello');
    expect(formatEmbeddingText('hello', 'document', 'ollama')).toBe('hello');
  });

  it('is consistent between query and document sides (same task instruction)', () => {
    const q = formatEmbeddingText('x', 'query', 'gemini');
    const d = formatEmbeddingText('x', 'document', 'gemini');
    // Both must be produced by the same formatting rules (documented pair).
    expect(q.startsWith('task: search result | query: ')).toBe(true);
    expect(d.startsWith('title: none | text: ')).toBe(true);
  });
});

describe('embedding-space compatibility', () => {
  const gemini = { provider: 'gemini' as const, model: 'gemini-embedding-2', dimension: 1536 };

  it('accepts identical spaces', () => {
    expect(spacesCompatible(gemini, { ...gemini })).toBe(true);
  });

  it('rejects different providers (Gemini vs Ollama)', () => {
    expect(spacesCompatible(gemini, { provider: 'ollama', model: 'embeddinggemma', dimension: 768 })).toBe(false);
  });

  it('rejects different models within one provider', () => {
    expect(spacesCompatible(gemini, { provider: 'gemini', model: 'gemini-embedding-001', dimension: 1536 })).toBe(false);
  });

  it('rejects different dimensions', () => {
    expect(spacesCompatible(gemini, { provider: 'gemini', model: 'gemini-embedding-2', dimension: 768 })).toBe(false);
  });

  it('assertStorableInIndex accepts a 1536-dim gemini vector', () => {
    expect(() =>
      assertStorableInIndex({ vector: vector(1536), provider: 'gemini', model: 'gemini-embedding-2', dimension: 1536 }, gemini),
    ).not.toThrow();
  });

  it('assertStorableInIndex refuses a 768-dim Ollama vector for the 1536 index (no padding/truncation)', () => {
    let thrown: unknown;
    try {
      assertStorableInIndex(
        { vector: vector(768), provider: 'ollama', model: 'embeddinggemma', dimension: 768 },
        { provider: 'ollama', model: 'embeddinggemma', dimension: 768 },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EmbeddingServiceError);
    expect((thrown as EmbeddingServiceError).code).toBe('SPACE_MISMATCH');
    expect((thrown as EmbeddingServiceError).message).toMatch(/never padded or truncated/i);
  });

  it('assertStorableInIndex refuses vectors from a non-active model', () => {
    expect(() =>
      assertStorableInIndex(
        { vector: vector(1536), provider: 'gemini', model: 'gemini-embedding-001', dimension: 1536 },
        gemini,
      ),
    ).toThrowError(expect.objectContaining({ code: 'SPACE_MISMATCH' }));
  });
});

describe('redaction', () => {
  it('redacts credential-shaped strings', () => {
    expect(redactSecrets('key AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAA and sk-abcdefgh12345678')).not.toMatch(/AIzaSyA/);
    expect(redactSecrets('Bearer abcdef1234567890')).toContain('[redacted]');
  });

  it('redacts the exact configured key value even when it has a non-standard shape', () => {
    vi.stubEnv('GEMINI_API_KEY', 'nonstandardkeyshape-53-chars-abcdefghijklmnop');
    const leaked = redactSecrets('oops the key is nonstandardkeyshape-53-chars-abcdefghijklmnop');
    expect(leaked).not.toContain('nonstandardkeyshape');
    expect(leaked).toContain('[redacted]');
  });
});

// ---------------------------------------------------------------------------
// Gemini provider (stubbed fetch)
// ---------------------------------------------------------------------------

describe('Gemini embedding provider (mocked HTTP)', () => {
  it('requests embedContent with output_dimensionality 1536 and the x-goog-api-key header', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embedding: { values: vector(1536) } }));

    const result = await embedWithMeta('I prefer Python for programming.', { provider: 'gemini', role: 'document' });

    expect(result.vector).toHaveLength(EMBEDDING_DIMENSION);
    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-embedding-2');
    expect(result.dimension).toBe(1536);

    const { url, init } = lastRequest();
    expect(url).toContain('models/gemini-embedding-2:embedContent');
    expect(url).not.toContain('test-gemini-key'); // key never in URL
    const headers = init.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('test-gemini-key-not-a-real-secret');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.output_dimensionality).toBe(1536);
    expect(JSON.stringify(body)).toContain('title: none | text:'); // document format
  });

  it('embeds queries with the query task prefix', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embedding: { values: vector(1536) } }));
    await embedWithMeta('What do I prefer?', { provider: 'gemini', role: 'query' });
    const body = String(lastRequest().init.body);
    expect(body).toContain('task: search result | query:');
  });

  it('returns finite values only (rejects NaN/Infinity)', async () => {
    const values = vector(1536);
    values[42] = Number.NaN;
    fetchMock.mockResolvedValue(jsonResponse(200, { embedding: { values } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects wrong dimensions (e.g. default 3072 without output_dimensionality)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embedding: { values: vector(3072) } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'DIM_MISMATCH' });
  });

  it('rejects a response without embedding.values', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects a non-JSON response', async () => {
    fetchMock.mockResolvedValue(textResponse(200, '<html>oops</html>'));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('maps 401/403 to AUTH', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { message: 'API key not valid' } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'AUTH' });
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { message: 'forbidden' } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('maps 400 with an API-key message to AUTH', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'AUTH' });
  });

  it('distinguishes QUOTA (429 + quota detail) from RATE_LIMIT (429)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: { message: 'Quota exceeded for quota metric', status: 'RESOURCE_EXHAUSTED' } }),
    );
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'QUOTA' });

    fetchMock.mockResolvedValue(jsonResponse(429, { error: { message: 'Too many requests, slow down' } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('maps 404 to MODEL_NOT_FOUND and other 400s to INVALID_REQUEST', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { message: 'models/nope is not found' } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });

    fetchMock.mockResolvedValue(jsonResponse(400, { error: { message: 'Invalid JSON payload received' } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('maps 5xx to FAIL', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { message: 'backend unavailable' } }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'FAIL' });
  });

  it('maps timeout aborts to TIMEOUT and network failures to NETWORK', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'TIMEOUT' });

    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }));
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('rejects empty input without calling the provider', async () => {
    await expect(embedWithMeta('   ', { provider: 'gemini' })).rejects.toMatchObject({ code: 'EMPTY_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing API key with NO_KEY', async () => {
    vi.stubEnv('GEMINI_API_KEY', '');
    await expect(embedWithMeta('text', { provider: 'gemini' })).rejects.toMatchObject({ code: 'NO_KEY' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never includes the API key in error messages', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: 'Invalid key AIzaSyFAKEKEYFAKEKEYFAKEKEYFAKEKEY' } }),
    );
    const err = await embedWithMeta('text', { provider: 'gemini' }).catch((e: unknown) => e as EmbeddingServiceError);
    expect(err).toBeInstanceOf(EmbeddingServiceError);
    expect((err as EmbeddingServiceError).message).not.toContain('AIzaSyFAKEKEY');
    expect((err as EmbeddingServiceError).message).toContain('[redacted]');
  });
});

// ---------------------------------------------------------------------------
// Ollama provider (stubbed fetch)
// ---------------------------------------------------------------------------

describe('Ollama embedding provider (mocked HTTP)', () => {
  it('posts to /api/embed with the configured model and parses embeddings[0] (array of arrays)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { model: 'embeddinggemma', embeddings: [vector(OLLAMA_EMBED_DIMENSION)] }));

    const result = await embedWithMeta('I prefer simple explanations.', { provider: 'ollama' });

    expect(result.vector).toHaveLength(768);
    expect(result.provider).toBe('ollama');
    expect(result.model).toBe('embeddinggemma');
    expect(result.dimension).toBe(768);

    const { url, init } = lastRequest();
    expect(url).toBe('http://localhost:11434/api/embed');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('embeddinggemma');
    expect(body.input).toBe('I prefer simple explanations.');
  });

  it('rejects the legacy flat-array misparse shape (embeddings as number[])', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: vector(768) }));
    await expect(embedWithMeta('text', { provider: 'ollama' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects NaN/Infinity values', async () => {
    const values = vector(768);
    values[7] = Number.POSITIVE_INFINITY;
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: [values] }));
    await expect(embedWithMeta('text', { provider: 'ollama' })).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('rejects wrong dimensions for embeddinggemma (768 expected)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { embeddings: [vector(512)] }));
    await expect(embedWithMeta('text', { provider: 'ollama' })).rejects.toMatchObject({ code: 'DIM_MISMATCH' });
  });

  it('maps a missing model to MODEL_NOT_FOUND', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'model "embeddinggemma" not found' }));
    await expect(embedWithMeta('text', { provider: 'ollama' })).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('maps timeouts and unreachable daemons to typed errors', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await expect(embedWithMeta('text', { provider: 'ollama' })).rejects.toMatchObject({ code: 'TIMEOUT' });

    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { name: 'TypeError' }));
    await expect(embedWithMeta('text', { provider: 'ollama' })).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('rejects empty input without calling Ollama', async () => {
    await expect(embedWithMeta('', { provider: 'ollama' })).rejects.toMatchObject({ code: 'EMPTY_INPUT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Offline mock path (regression suite stays offline)
// ---------------------------------------------------------------------------

describe('offline mock path', () => {
  it('embed() short-circuits to the deterministic mock in test env (no HTTP)', async () => {
    const a = await embed('same input', { role: 'query' });
    const b = await embed('same input', { role: 'document' });
    expect(a).toHaveLength(1536);
    expect(a).toEqual(b);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mock vectors are finite and normalized', async () => {
    const v = await embed('normalize me');
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});
