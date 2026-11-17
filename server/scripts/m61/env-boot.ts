/**
 * scripts/m61/env-boot.ts
 * -----------------------
 * Phase 6.1 (M6.1) live-verification environment boot.
 *
 * THIS FILE MUST BE THE FIRST IMPORT of every m61 driver (and it is the
 * first import of ./common.ts): it synchronously pins the process to the
 * ISOLATED LOCAL stack before any `src/**` module runs its module-level
 * environment checks (supabase.service.ts and ai.service.ts read
 * process.env at import time).
 *
 * Guarantees:
 *   - SUPABASE_URL is forced to the LOCAL shim (127.0.0.1:55437). The
 *     remote Supabase project in server/.env is NEVER contacted: this
 *     module deliberately does not load dotenv, so the remote URL can
 *     never win.
 *   - GEMINI_BASE_URL points at the local LLM stub (127.0.0.1:55438) —
 *     no external model calls, no API charges.
 *   - Secrets (JWT_SECRET / POSTGRES_PASSWORD from
 *     supabase/local-dev/.env.m61) are read for local token signing ONLY
 *     and are never printed or written anywhere else.
 *
 * No product code is modified by any m61 driver.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Locate the repo (works whether invoked from repo root or server/)
// ---------------------------------------------------------------------------

function locate(rel: string): string {
  const bases = [
    process.cwd(),
    path.resolve(process.cwd(), 'server'),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '..', 'server'),
  ];
  for (const base of bases) {
    const p = path.resolve(base, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`m61 env-boot: cannot locate ${rel} (cwd=${process.cwd()})`);
}

const ENV_FILE = locate('supabase/local-dev/.env.m61');
/** <repo>/supabase/local-dev/.env.m61 → up three levels = repo root. */
export const REPO_ROOT = path.dirname(path.dirname(path.dirname(ENV_FILE)));
export const SERVER_DIR = path.join(REPO_ROOT, 'server');

// ---------------------------------------------------------------------------
// Parse .env.m61 (values kept module-private; never logged)
// ---------------------------------------------------------------------------

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && m[1] !== undefined) {
      let v = m[2] ?? '';
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  }
  return out;
}

const LOCAL_ENV = parseEnvFile(ENV_FILE);

const JWT_SECRET = LOCAL_ENV['JWT_SECRET'];
if (!JWT_SECRET) {
  throw new Error('m61 env-boot: JWT_SECRET missing from supabase/local-dev/.env.m61');
}

// ---------------------------------------------------------------------------
// HS256 JWT signing (local stack keys only)
// ---------------------------------------------------------------------------

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Sign a JWT with the LOCAL stack secret (never leaves this machine). */
export function signLocalJwt(
  payload: Record<string, unknown>,
  expiresInSec: number,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat, exp: iat + expiresInSec };
  const head = b64url(JSON.stringify(header));
  const claims = b64url(JSON.stringify(body));
  const sig = crypto
    .createHmac('sha256', JWT_SECRET as string)
    .update(`${head}.${claims}`)
    .digest('base64url');
  return `${head}.${claims}.${sig}`;
}

// ---------------------------------------------------------------------------
// Pin the process to the isolated local stack
// ---------------------------------------------------------------------------

export const SHIM_URL = 'http://127.0.0.1:55437';
export const LLM_STUB_URL = 'http://127.0.0.1:55438';

export const USER_A = '3975c1b6-e6cb-4932-8c84-e8ac69272d64';
export const USER_B = 'c92cf2fc-c2e6-47cc-ae46-5a89825e907a';
export const EMAIL_A = 'api-a@m61.test';
export const EMAIL_B = 'api-b@m61.test';
/** Local-only password for the two verification users (reset via GoTrue admin). */
const LOCAL_PASSWORD = 'M61-local-verify-2026!';

// Never a remote URL — hard-pinned to the local shim.
process.env['SUPABASE_URL'] = SHIM_URL;
// Public anon key (local legacy-style JWT signed with the local secret).
// NOTE: `sub` must be a valid uuid — PostgREST policies call auth.uid(),
// which casts the claim to uuid; a non-uuid sub is a 400, not a silent 0.
process.env['SUPABASE_ANON_KEY'] = signLocalJwt(
  { iss: 'supabase', role: 'anon', sub: '00000000-0000-4000-a000-000000000000' },
  10 * 365 * 24 * 3600,
);
// Transport-level LLM stub — no external calls possible.
process.env['GEMINI_API_KEY'] = 'm61-local-stub-key';
process.env['GEMINI_BASE_URL'] = LLM_STUB_URL;
process.env['GEMINI_MODEL'] = process.env['GEMINI_MODEL'] ?? 'm61-local-stub';
// Make sure no ambient service-role key is ever in play for these drivers.
delete process.env['SUPABASE_SERVICE_ROLE_KEY'];

export const M61_LOCAL_ENV = LOCAL_ENV; // keys only are ever printed by callers
export { JWT_SECRET, LOCAL_PASSWORD };
