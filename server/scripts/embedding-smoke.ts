/**
 * scripts/embedding-smoke.ts
 * --------------------------
 * EXPLICIT LIVE smoke test for the Milestone 4.1 embedding providers
 * (Task A: Gemini, Task B: Ollama). Performs REAL HTTP calls — it never
 * runs inside the regression suite. Invoke manually from `server/`:
 *
 *   npm run smoke:embeddings                 # both providers
 *   npm run smoke:embeddings:gemini          # Gemini only
 *   npm run smoke:embeddings:ollama          # Ollama only
 *
 * Verified per provider:
 *   - live response succeeds for the 4 required inputs
 *   - vector dimension (Gemini 1536 / embeddinggemma 768)
 *   - every value numeric and finite (no NaN/Infinity)
 *   - repeated identical inputs are consistent (cosine >= threshold,
 *     default 0.98, configurable via SMOKE_CONSISTENCY_THRESHOLD)
 *   - error handling is typed and safe: empty input, invalid API key,
 *     model not found, unreachable daemon — with redacted messages
 *
 * Output contains ONLY metrics, statuses and redacted/typed errors:
 * never API keys, never full request contents, never raw vectors.
 *
 * Exit code: 0 = every executed check passed; 1 = failure or incomplete
 * verification (e.g. embeddinggemma not installed — instructions printed).
 */

import 'dotenv/config';
import {
  embedWithMeta,
  EmbeddingServiceError,
  EMBEDDING_DIMENSION,
  OLLAMA_EMBED_DIMENSION,
  redactSecrets,
} from '../src/services/embedding.service.js';

// ---------------------------------------------------------------------------
// Required inputs (Milestone 4.1 Task A)
// ---------------------------------------------------------------------------

const INPUTS: ReadonlyArray<string> = [
  'I prefer Python for programming.',
  'I am preparing for Data Analyst placements.',
  'My project is an AI-powered personal assistant.',
  'I prefer simple explanations with practical examples.',
];

const CONSISTENCY_THRESHOLD = (() => {
  const v = Number(process.env.SMOKE_CONSISTENCY_THRESHOLD);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.98;
})();

type Status = 'pass' | 'fail';
interface Check {
  provider: string;
  name: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];

function record(provider: string, name: string, status: Status, detail: string): void {
  checks.push({ provider, name, status, detail });
  const tag = status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name} — ${redactSecrets(detail, 240)}`);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function l2norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function finiteReport(v: number[]): { allFinite: boolean; badIndex: number } {
  for (let i = 0; i < v.length; i += 1) {
    if (!Number.isFinite(v[i] as number)) return { allFinite: false, badIndex: i };
  }
  return { allFinite: true, badIndex: -1 };
}

function preview(text: string): string {
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

async function embedChecked(
  provider: 'gemini' | 'ollama',
  text: string,
  role: 'query' | 'document',
  label: string,
): Promise<number[] | null> {
  try {
    const started = Date.now();
    const result = await embedWithMeta(text, { provider, role });
    const ms = Date.now() - started;
    const { allFinite, badIndex } = finiteReport(result.vector);
    record(
      provider,
      label,
      allFinite ? 'pass' : 'fail',
      `input="${preview(text)}" role=${role} dims=${result.dimension} finite=${allFinite}` +
        (allFinite ? ` norm=${l2norm(result.vector).toFixed(4)} latency=${ms}ms` : ` firstBadIndex=${badIndex}`),
    );
    if (!allFinite) return null;
    return result.vector;
  } catch (err) {
    const e = err instanceof EmbeddingServiceError ? err : null;
    record(
      provider,
      label,
      'fail',
      e ? `typed error ${e.code}: ${e.message}` : `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function expectTypedError(
  provider: 'gemini' | 'ollama',
  name: string,
  expectedCodes: string[],
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
    record(provider, name, 'fail', `expected one of [${expectedCodes.join(', ')}] but the call succeeded`);
  } catch (err) {
    if (err instanceof EmbeddingServiceError && err.code && expectedCodes.includes(err.code)) {
      record(provider, name, 'pass', `typed error ${err.code} (message redacted: ${redactSecrets(err.message, 160)})`);
    } else if (err instanceof EmbeddingServiceError) {
      record(provider, name, 'fail', `expected [${expectedCodes.join(', ')}] but got ${err.code}`);
    } else {
      record(provider, name, 'fail', `expected a typed EmbeddingServiceError, got: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider runs
// ---------------------------------------------------------------------------

async function runGemini(): Promise<void> {
  console.log('\n=== Task A — LIVE Gemini embedding smoke test ===');
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    record('gemini', 'API key configured', 'fail', 'GEMINI_API_KEY is absent — get a key at https://aistudio.google.com/apikey and add it to server/.env');
    return;
  }
  record('gemini', 'API key configured', 'pass', `present (shape AIza: ${/^AIza/.test(key)}, length bucket: ${Math.floor(key.length / 10) * 10}±10)`);

  const expectedDim = EMBEDDING_DIMENSION;
  const vectors: Array<number[] | null> = [];

  for (let i = 0; i < INPUTS.length; i += 1) {
    const input = INPUTS[i] as string;
    const first = await embedChecked('gemini', input, 'document', `input ${i + 1}/4 (run 1)`);
    const second = await embedChecked('gemini', input, 'document', `input ${i + 1}/4 (run 2 — consistency)`);
    vectors.push(first);
    if (first && second) {
      if (first.length !== expectedDim || second.length !== expectedDim) {
        record('gemini', `input ${i + 1}/4 dimensions`, 'fail', `expected ${expectedDim}, got ${first.length}/${second.length}`);
      } else {
        record('gemini', `input ${i + 1}/4 dimensions`, 'pass', `${first.length} dims (expected ${expectedDim})`);
      }
      const sim = cosine(first, second);
      record(
        'gemini',
        `input ${i + 1}/4 repeat-consistency`,
        sim >= CONSISTENCY_THRESHOLD ? 'pass' : 'fail',
        `cosine(run1, run2)=${sim.toFixed(6)} (threshold ${CONSISTENCY_THRESHOLD})`,
      );
    }
  }

  // Query-side formatting path (asymmetric retrieval format).
  await embedChecked('gemini', INPUTS[0] as string, 'query', 'query-role embed (task prefix path)');

  // Cross-input dimension stability.
  const dims = vectors.filter((v): v is number[] => Boolean(v)).map((v) => v.length);
  if (dims.length > 0) {
    const stable = dims.every((d) => d === expectedDim);
    record('gemini', 'dimension stability across inputs', stable ? 'pass' : 'fail', `dims=[${dims.join(', ')}] expected=${expectedDim}`);
  }

  // --- Error handling (safe, no side effects) ---
  await expectTypedError('gemini', 'empty input rejected without HTTP', ['EMPTY_INPUT'], () =>
    embedWithMeta('   ', { provider: 'gemini' }),
  );

  const realKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'invalid-key-for-smoke-auth-check';
  try {
    await expectTypedError('gemini', 'invalid API key handled as typed auth error', ['AUTH', 'INVALID_REQUEST'], () =>
      embedWithMeta('I prefer Python for programming.', { provider: 'gemini' }),
    );
  } finally {
    if (realKey !== undefined) process.env.GEMINI_API_KEY = realKey;
  }
}

async function runOllama(): Promise<void> {
  console.log('\n=== Task B — LIVE Ollama embedding smoke test (embeddinggemma) ===');
  const base = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_EMBEDDING_MODEL || 'embeddinggemma';
  console.log(`  config: OLLAMA_BASE_URL=${base} OLLAMA_EMBEDDING_MODEL=${model}`);

  // 1. Daemon reachability.
  let tags: string[] = [];
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    tags = (data.models ?? []).map((m) => String(m.name ?? ''));
    record('ollama', 'daemon reachable', 'pass', `${base}/api/tags HTTP 200 (${tags.length} model(s) installed)`);
  } catch (err) {
    record('ollama', 'daemon reachable', 'fail', `cannot reach ${base} — start it with: ollama serve (install: https://ollama.com/download) — error: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 2. Model availability (never assume it is installed).
  const installed = tags.some((t) => t === model || t.startsWith(`${model}:`));
  if (!installed) {
    record('ollama', 'embeddinggemma model installed', 'fail', `model "${model}" not found — run exactly: ollama pull ${model}  (then re-run this smoke test). Installed: [${tags.join(', ') || 'none'}]`);
    return;
  }
  record('ollama', 'embeddinggemma model installed', 'pass', `found among [${tags.join(', ')}]`);

  const expectedDim = OLLAMA_EMBED_DIMENSION;
  const vectors: Array<number[] | null> = [];

  for (let i = 0; i < INPUTS.length; i += 1) {
    const input = INPUTS[i] as string;
    const first = await embedChecked('ollama', input, 'document', `input ${i + 1}/4 (run 1)`);
    const second = await embedChecked('ollama', input, 'document', `input ${i + 1}/4 (run 2 — consistency)`);
    vectors.push(first);
    if (first && second) {
      if (first.length !== expectedDim || second.length !== expectedDim) {
        record('ollama', `input ${i + 1}/4 dimensions`, 'fail', `expected ${expectedDim} for ${model}, got ${first.length}/${second.length}`);
      } else {
        record('ollama', `input ${i + 1}/4 dimensions`, 'pass', `${first.length} dims (native ${expectedDim})`);
      }
      const sim = cosine(first, second);
      record(
        'ollama',
        `input ${i + 1}/4 repeat-consistency`,
        sim >= CONSISTENCY_THRESHOLD ? 'pass' : 'fail',
        `cosine(run1, run2)=${sim.toFixed(6)} (threshold ${CONSISTENCY_THRESHOLD})`,
      );
    }
  }

  await embedChecked('ollama', INPUTS[0] as string, 'query', 'query-role embed (raw passthrough path)');

  const dims = vectors.filter((v): v is number[] => Boolean(v)).map((v) => v.length);
  if (dims.length > 0) {
    const stable = dims.every((d) => d === expectedDim);
    record('ollama', 'dimension stability across inputs', stable ? 'pass' : 'fail', `dims=[${dims.join(', ')}] expected=${expectedDim}`);
  }

  // --- Error handling (safe, no side effects) ---
  await expectTypedError('ollama', 'empty input rejected without HTTP', ['EMPTY_INPUT'], () =>
    embedWithMeta('', { provider: 'ollama' }),
  );

  const realModel = process.env.OLLAMA_EMBEDDING_MODEL;
  process.env.OLLAMA_EMBEDDING_MODEL = 'deeksh-model-that-does-not-exist';
  try {
    await expectTypedError('ollama', 'missing model handled as MODEL_NOT_FOUND', ['MODEL_NOT_FOUND'], () =>
      embedWithMeta('I prefer Python for programming.', { provider: 'ollama' }),
    );
  } finally {
    if (realModel !== undefined) process.env.OLLAMA_EMBEDDING_MODEL = realModel;
    else delete process.env.OLLAMA_EMBEDDING_MODEL;
  }

  const realBase = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9';
  try {
    await expectTypedError('ollama', 'unreachable daemon handled as NETWORK/TIMEOUT', ['NETWORK', 'TIMEOUT'], () =>
      embedWithMeta('I prefer Python for programming.', { provider: 'ollama' }),
    );
  } finally {
    if (realBase !== undefined) process.env.OLLAMA_BASE_URL = realBase;
    else delete process.env.OLLAMA_BASE_URL;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function summarize(): number {
  console.log('\n=== Summary ===');
  const providers = ['gemini', 'ollama'];
  let failedProviders = 0;
  for (const p of providers) {
    const own = checks.filter((c) => c.provider === p);
    if (own.length === 0) continue;
    const failed = own.filter((c) => c.status === 'fail');
    if (failed.length === 0) {
      console.log(`${p.toUpperCase()}: PASS — ${own.length}/${own.length} checks`);
    } else {
      failedProviders += 1;
      console.log(`${p.toUpperCase()}: FAIL — ${failed.length}/${own.length} checks failed:`);
      for (const f of failed) console.log(`  - ${f.name}: ${redactSecrets(f.detail, 240)}`);
    }
  }
  return failedProviders;
}

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith('--provider='));
  const provider = arg ? arg.split('=')[1] : 'both';

  console.log('Embedding live smoke test (Milestone 4.1)');
  console.log(`NODE_ENV=${process.env.NODE_ENV ?? '(unset)'} provider-arg=${provider} consistency-threshold=${CONSISTENCY_THRESHOLD}`);
  console.log('Note: metrics only — no API keys, raw vectors or full request contents are printed.');

  if (provider === 'gemini' || provider === 'both') await runGemini();
  if (provider === 'ollama' || provider === 'both') await runOllama();
  if (provider !== 'gemini' && provider !== 'ollama' && provider !== 'both') {
    console.error(`Unknown --provider=${provider} (use gemini | ollama | both)`);
    process.exit(2);
  }

  const failedProviders = summarize();
  if (failedProviders > 0) {
    console.log('\nRESULT: FAILED or INCOMPLETE — see failing checks above.');
    process.exit(1);
  }
  console.log('\nRESULT: all executed checks passed.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Smoke test crashed:', redactSecrets(err instanceof Error ? err.message : String(err), 300));
  process.exit(1);
});
