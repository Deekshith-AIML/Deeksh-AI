/**
 * tests/helpers/fakeSupabase.ts
 * -----------------------------
 * In-memory test double for the Supabase client used by the API server.
 *
 * What it emulates:
 * - `auth.getUser(token)` — validates tokens against a registry
 *   (valid / expired / unknown), mirroring how the real client returns
 *   `{ data: { user }, error }` for each case.
 * - `client.from(table)` — the PostgREST query-builder chains used by
 *   task.service.ts / ai.service.ts: select/insert/update/delete,
 *   eq/neq/order/limit/single/maybeSingle, thenable results, and the
 *   error/data envelope.
 * - Optional per-table operation failures for testing DB-error handling.
 *
 * What it deliberately does NOT emulate:
 * - Row Level Security. Keeping RLS out of the double means the tests
 *   verify the SERVICE-LAYER ownership filters (`.eq('user_id', ...)`);
 *   if a filter were missing, cross-user leaks WOULD fail these tests.
 *   RLS itself must be verified against a live Supabase project (see
 *   final report limitations).
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface FakeTask {
  id: string;
  user_id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  created_at: string;
}

export interface FakeMessage {
  id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface FakeReminder {
  id: string;
  user_id: string;
  task_id: string | null;
  title: string;
  reminder_at: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  last_attempt_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  claimed_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Row in `public.users` (application profile). */
export interface FakeProfile {
  id: string;
  email: string;
  provider: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at?: string;
}

/** Row in `public.integration_grants` (explicit consent record). */
export interface FakeGrant {
  id: string;
  user_id: string;
  integration: string;
  scopes: string[];
  granted_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at?: string;
}

/** Row in `public.memories` (Milestone 4). */
export interface FakeMemory {
  id: string;
  user_id: string;
  content: string;
  content_summary: string | null;
  category: string;
  embedding_provider: string;
  embedding_model_version: string;
  embedding_dimensions: number;
  source_message_id: string | null;
  source_evidence: string | null;
  confidence: string;
  status: string;
  superseded_by: string | null;
  supersession_confirmed_by_user: boolean;
  conflict_with?: string | null;
  sensitivity: string;
  extraction_timestamp: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expired_at: string | null;
}

/** Row in `public.memory_settings` (Milestone 4 — user consent). */
export interface FakeMemorySettings {
  user_id: string;
  automatic_memory_extraction: boolean;
  similarity_threshold: number;
  include_memory_in_chat: boolean;
  include_sensitive_in_chat: boolean;
  max_memory_context_chars: number;
  created_at: string;
  updated_at: string;
}

/** Row in `public.memory_extraction_jobs` (Milestone 4 — durable outbox). */
export interface FakeExtractionJob {
  id: string;
  user_id: string;
  message_id: string | null;
  status: string;
  claimed_at: string | null;
  attempts: number;
  failed_at: string | null;
  error_message: string | null;
  result_memory_ids: string[];
  created_at: string;
  updated_at: string;
}

/** Row in `public.documents` (Milestone 5 — Knowledge Base). */
export interface FakeDocument {
  id: string;
  user_id: string;
  original_filename: string;
  storage_filename: string;
  extension: string;
  mime_type: string;
  file_size: number;
  content_hash: string;
  storage_path: string;
  status: string;
  page_count: number | null;
  text_char_count: number | null;
  chunk_count: number;
  extraction_metadata: Record<string, unknown>;
  error_message: string | null;
  deletion_attempts: number;
  deletion_error: string | null;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row in `public.document_chunks` (Milestone 5). */
export interface FakeDocumentChunk {
  id: string;
  document_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  embedding: number[] | null;
  embedding_provider: string;
  embedding_model_version: string;
  embedding_dimensions: number;
  page_start: number | null;
  page_end: number | null;
  heading: string | null;
  section_path: string | null;
  paragraph_start: number | null;
  paragraph_end: number | null;
  char_start: number | null;
  char_end: number | null;
  token_estimate: number | null;
  created_at: string;
}

/** Row in `public.document_processing_jobs` (Milestone 5). */
export interface FakeDocumentJob {
  id: string;
  document_id: string;
  user_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  claimed_at: string | null;
  last_attempt_at: string | null;
  next_attempt_at: string;
  failed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-user auth metadata reported back by `auth.getUser`. */
interface FakeUserMeta {
  provider: 'email' | 'google';
  displayName: string | null;
  avatarUrl: string | null;
}

interface FakeState {
  /** token → userId for tokens considered VALID by auth.getUser. */
  validTokens: Map<string, string>;
  /** Tokens explicitly marked expired (auth.getUser returns an error). */
  expiredTokens: Set<string>;
  /** Tokens explicitly REVOKED (session ended / signed out elsewhere). */
  revokedTokens: Set<string>;
  /** userId → email (for getUser responses). */
  emails: Map<string, string>;
  /** userId → auth metadata (provider/name/avatar) for getUser responses. */
  userMeta: Map<string, FakeUserMeta>;
  tasks: FakeTask[];
  messages: FakeMessage[];
  reminders: FakeReminder[];
  users: FakeProfile[];
  integrationGrants: FakeGrant[];
  memories: FakeMemory[];
  memorySettings: FakeMemorySettings[];
  extractionJobs: FakeExtractionJob[];
  documents: FakeDocument[];
  documentChunks: FakeDocumentChunk[];
  documentJobs: FakeDocumentJob[];
  /** Monotonic counter for deterministic created_at ordering. */
  seq: number;
  /** Injected DB failures consumed on the next matching operation. */
  failures: Array<{ table: string; op: string; message: string }>;
  /**
   * One-shot simulated RACES: when the next insert on `table` executes,
   * `row` is inserted first (as if another request won) and the insert
   * then fails with 23505 — mirroring the unique-index race the real
   * database can produce.
   */
  concurrentInserts: Array<{ table: string; row: Record<string, unknown> }>;
}

const state: FakeState = {
  validTokens: new Map(),
  expiredTokens: new Set(),
  revokedTokens: new Set(),
  emails: new Map(),
  userMeta: new Map(),
  tasks: [],
  messages: [],
  reminders: [],
  users: [],
  integrationGrants: [],
  memories: [],
  memorySettings: [],
  extractionJobs: [],
  documents: [],
  documentChunks: [],
  documentJobs: [],
  seq: 0,
  failures: [],
  concurrentInserts: [],
};

/** Options controlling the seeded profile / auth metadata for a user. */
export interface RegisterUserOptions {
  /** Auth provider reported by `auth.getUser` (default 'email'). */
  provider?: 'email' | 'google';
  /** Provider-supplied display name (user_metadata.full_name). */
  displayName?: string;
  /** Provider-supplied avatar URL. */
  avatarUrl?: string;
  /**
   * Skip seeding the `public.users` profile row — simulates a missing
   * profile that the API must self-heal (GET /api/me insert path).
   */
  noProfile?: boolean;
}

/** Register a user + bearer token that `auth.getUser` will accept. */
export function registerUser(
  token: string,
  userId: string,
  email: string,
  opts: RegisterUserOptions = {},
): void {
  const provider = opts.provider ?? 'email';
  state.validTokens.set(token, userId);
  state.emails.set(userId, email);
  state.userMeta.set(userId, {
    provider,
    displayName: opts.displayName ?? null,
    avatarUrl: opts.avatarUrl ?? null,
  });

  if (!opts.noProfile) {
    state.users.push({
      id: userId,
      email,
      provider,
      display_name: opts.displayName ?? null,
      avatar_url: opts.avatarUrl ?? null,
      created_at: new Date(1_700_000_000_000 + (state.seq += 1)).toISOString(),
    });
  }
}

/** Mark a previously registered token as expired (auth.getUser errors). */
export function expireToken(token: string): void {
  state.validTokens.delete(token);
  state.expiredTokens.add(token);
}

/**
 * REVOKE a token (session signed out / revoked server-side). Distinct from
 * `expireToken`: the auth server reports the session as no longer valid —
 * `auth.getUser` fails exactly like any other rejected token.
 */
export function revokeToken(token: string): void {
  state.validTokens.delete(token);
  state.revokedTokens.add(token);
}

/** Make the next matching table/op fail with a DB error. */
export function injectDatabaseFailure(table: string, op: string, message = 'simulated database failure'): void {
  state.failures.push({ table, op, message });
}

/**
 * Simulate a concurrent insert race: the next insert on `table` first
 * materializes `row` (as if another request committed first) and then
 * fails with 23505 — exercising the services' race-safe fallbacks.
 */
export function injectConcurrentInsert(table: string, row: Record<string, unknown>): void {
  state.concurrentInserts.push({ table, row });
}

// ---------------------------------------------------------------------------
// Fake private object storage (Milestone 5)
// ---------------------------------------------------------------------------

interface StoredObject {
  bytes: Buffer;
  contentType: string;
}

type StorageOp = 'upload' | 'download' | 'remove' | 'sign';

const storageObjects = new Map<string, StoredObject>();
const storageFailures: Array<{ op: StorageOp; message: string }> = [];

function storageKey(bucket: string, path: string): string {
  return `${bucket}/${path}`;
}

/** Make the next storage operation of `op` fail. */
export function injectStorageFailure(op: StorageOp, message = 'simulated storage failure'): void {
  storageFailures.push({ op, message });
}

/** Seed an object directly (as if it had been uploaded earlier). */
export function seedStoredObject(
  bucket: string,
  path: string,
  bytes: Buffer,
  contentType = 'application/octet-stream',
): void {
  storageObjects.set(storageKey(bucket, path), { bytes: Buffer.from(bytes), contentType });
}

/** Test-facing view of the fake bucket. */
export const fakeStorage = {
  get objects(): Map<string, StoredObject> {
    return storageObjects;
  },
  has(bucket: string, path: string): boolean {
    return storageObjects.has(storageKey(bucket, path));
  },
  bytes(bucket: string, path: string): Buffer | undefined {
    return storageObjects.get(storageKey(bucket, path))?.bytes;
  },
  keys(): string[] {
    return [...storageObjects.keys()];
  },
};

function takeStorageFailure(op: StorageOp): { message: string } | null {
  const idx = storageFailures.findIndex((f) => f.op === op);
  if (idx === -1) return null;
  const [failure] = storageFailures.splice(idx, 1);
  return { message: failure!.message };
}

/** Reset all in-memory data between tests. */
export function resetFakeSupabase(): void {
  state.validTokens.clear();
  state.expiredTokens.clear();
  state.revokedTokens.clear();
  state.emails.clear();
  state.userMeta.clear();
  state.tasks = [];
  state.messages = [];
  state.reminders = [];
  state.users = [];
  state.integrationGrants = [];
  state.memories = [];
  state.memorySettings = [];
  state.extractionJobs = [];
  state.documents = [];
  state.documentChunks = [];
  state.documentJobs = [];
  storageObjects.clear();
  storageFailures.length = 0;
  state.seq = 0;
  state.failures = [];
  state.concurrentInserts = [];
  forcedMatchSimilarity = null;
}

/**
 * Test hook for `match_memories`: force the similarity value returned for
 * every active memory (e.g. 0.95 for duplicate detection, 0.8 for conflict).
 * Pass `null` to restore default behaviour. Reset by `resetFakeSupabase()`.
 */
let forcedMatchSimilarity: number | null = null;
export function forceMatchSimilarity(value: number | null): void {
  forcedMatchSimilarity = value;
}

/** Direct access for seeding/assertions in tests. */
export const fakeDb = {
  get tasks() {
    return state.tasks;
  },
  get messages() {
    return state.messages;
  },
  get reminders() {
    return state.reminders;
  },
  get users() {
    return state.users;
  },
  get integration_grants() {
    return state.integrationGrants;
  },
  get memories() {
    return state.memories;
  },
  get memory_settings() {
    return state.memorySettings;
  },
  get memory_extraction_jobs() {
    return state.extractionJobs;
  },
  get documents() {
    return state.documents;
  },
  get document_chunks() {
    return state.documentChunks;
  },
  get document_processing_jobs() {
    return state.documentJobs;
  },
};

/** Return the backing array for a supported table (structurally typed). */
function rowsFor(table: string): Array<Record<string, unknown>> {
  if (table === 'tasks') return state.tasks as unknown as Array<Record<string, unknown>>;
  if (table === 'messages') return state.messages as unknown as Array<Record<string, unknown>>;
  if (table === 'reminders') return state.reminders as unknown as Array<Record<string, unknown>>;
  if (table === 'users') return state.users as unknown as Array<Record<string, unknown>>;
  if (table === 'integration_grants') {
    return state.integrationGrants as unknown as Array<Record<string, unknown>>;
  }
  if (table === 'memories') return state.memories as unknown as Array<Record<string, unknown>>;
  if (table === 'memory_settings') {
    return state.memorySettings as unknown as Array<Record<string, unknown>>;
  }
  if (table === 'memory_extraction_jobs') {
    return state.extractionJobs as unknown as Array<Record<string, unknown>>;
  }
  if (table === 'documents') return state.documents as unknown as Array<Record<string, unknown>>;
  if (table === 'document_chunks') {
    return state.documentChunks as unknown as Array<Record<string, unknown>>;
  }
  if (table === 'document_processing_jobs') {
    return state.documentJobs as unknown as Array<Record<string, unknown>>;
  }
  throw new Error(`fakeSupabase: unexpected table "${table}"`);
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

interface FakeResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

type Op = 'select' | 'insert' | 'update' | 'delete';

class FakeQuery implements PromiseLike<FakeResult> {
  private op: Op = 'select';
  private eqs: Array<[string, unknown]> = [];
  private neqs: Array<[string, unknown]> = [];
  private lts: Array<[string, unknown]> = [];
  private ilikes: Array<[string, string]> = [];
  private ins: Array<[string, unknown[]]> = [];
  private patch: Record<string, unknown> | null = null;
  private insertRows: Array<Record<string, unknown>> = [];
  private orderSpec: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;
  private terminal: 'single' | 'maybeSingle' | null = null;
  private returning = false;
  private upsertMode = false;

  constructor(
    private readonly table: string,
    private readonly nextSeq: () => number,
  ) {}

  // --- builder methods ------------------------------------------------------

  select(_cols = '*'): this {
    if (this.op !== 'select') this.returning = true;
    return this;
  }

  insert(rows: Record<string, unknown> | Array<Record<string, unknown>>): this {
    this.op = 'insert';
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  /**
   * PostgREST `upsert`: insert, or update the existing row matched by the
   * primary key (`id`) or natural key (`user_id`) when present.
   */
  upsert(rows: Record<string, unknown> | Array<Record<string, unknown>>, _opts?: unknown): this {
    this.op = 'insert';
    this.upsertMode = true;
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  update(patch: Record<string, unknown>): this {
    this.op = 'update';
    this.patch = patch;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.eqs.push([column, value]);
    return this;
  }

  /** Less-than filter (column < value), lexicographic for strings. */
  lt(column: string, value: unknown): this {
    this.lts.push([column, value]);
    return this;
  }

  /** `IN` filter — column value must be one of `values`. */
  in(column: string, values: unknown[]): this {
    this.ins.push([column, values]);
    return this;
  }

  /** Case-insensitive substring match with SQL `%` wildcards. */
  ilike(column: string, pattern: string): this {
    this.ilikes.push([column, pattern]);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.neqs.push([column, value]);
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderSpec = { col: column, asc: opts?.ascending !== false };
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  single(): this {
    this.terminal = 'single';
    return this;
  }

  maybeSingle(): this {
    this.terminal = 'maybeSingle';
    return this;
  }

  // --- execution ------------------------------------------------------------

  private matches(row: Record<string, unknown>): boolean {
    for (const [col, val] of this.eqs) {
      if (row[col] !== val) return false;
    }
    for (const [col, val] of this.neqs) {
      if (row[col] === val) return false;
    }
    for (const [col, val] of this.lts) {
      const a = String(row[col] ?? '');
      const b = String(val ?? '');
      if (!(a < b)) return false;
    }
    for (const [col, vals] of this.ins) {
      if (!vals.includes(row[col])) return false;
    }
    for (const [col, pattern] of this.ilikes) {
      const value = String(row[col] ?? '').toLowerCase();
      const needle = pattern.replace(/%/g, '').toLowerCase();
      if (!value.includes(needle)) return false;
    }
    return true;
  }

  private takeFailure(): FakeResult['error'] {
    const idx = state.failures.findIndex(
      (f) => f.table === this.table && f.op === this.op,
    );
    if (idx === -1) return null;
    const [failure] = state.failures.splice(idx, 1);
    return { message: failure!.message, code: 'XX000' };
  }

  private sorted(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (!this.orderSpec) return rows;
    const { col, asc } = this.orderSpec;
    return [...rows].sort((a, b) => {
      const av = String(a[col] ?? '');
      const bv = String(b[col] ?? '');
      if (av === bv) return 0;
      return asc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
    });
  }

  private applyTerminal(rows: Array<Record<string, unknown>>): FakeResult {
    if (this.terminal === 'single') {
      if (rows.length !== 1) {
        return {
          data: null,
          error: {
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
          },
        };
      }
      return { data: rows[0], error: null };
    }
    if (this.terminal === 'maybeSingle') {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }

  private execute(): FakeResult {
    const failure = this.takeFailure();
    if (failure) return { data: null, error: failure };

    switch (this.op) {
      case 'select': {
        let rows = rowsFor(this.table).filter((r) => this.matches(r));
        rows = this.sorted(rows);
        if (this.limitN !== null) rows = rows.slice(0, this.limitN);
        return this.applyTerminal(rows);
      }

      case 'insert': {
        // Upsert semantics: update the existing row matched by id/user_id.
        if (this.upsertMode) {
          const updated: Array<Record<string, unknown>> = [];
          for (const row of this.insertRows) {
            const key =
              typeof row.id === 'string' ? ['id', row.id]
              : typeof row.user_id === 'string' ? ['user_id', row.user_id]
              : null;
            const existing = key
              ? rowsFor(this.table).find((r) => r[key[0]!] === key[1])
              : undefined;
            if (existing) {
              Object.assign(existing, row, {
                updated_at: new Date(1_700_000_000_000 + this.nextSeq()).toISOString(),
              });
              updated.push(existing);
            } else {
              const full = {
                id: randomUUID(),
                created_at: new Date(1_700_000_000_000 + this.nextSeq()).toISOString(),
                ...row,
              };
              rowsFor(this.table).push(full);
              updated.push(full);
            }
          }
          return this.returning
            ? this.applyTerminal(updated)
            : { data: null, error: null };
        }

        // Simulated concurrent-request race: another transaction commits
        // its row first, so our insert violates the unique index (23505).
        const raceIdx = state.concurrentInserts.findIndex((c) => c.table === this.table);
        if (raceIdx !== -1) {
          const [race] = state.concurrentInserts.splice(raceIdx, 1);
          rowsFor(this.table).push({
            id: randomUUID(),
            created_at: new Date(1_700_000_000_000 + this.nextSeq()).toISOString(),
            ...race!.row,
          });
          return {
            data: null,
            error: {
              message:
                'duplicate key value violates unique constraint',
              code: '23505',
            },
          };
        }

        // Always-on unique emulation for integration_grants (user_id +
        // integration), mirroring migration 0004's UNIQUE constraint.
        if (this.table === 'integration_grants') {
          for (const row of this.insertRows) {
            const conflict = state.integrationGrants.some(
              (g) => g.user_id === row.user_id && g.integration === row.integration,
            );
            if (conflict) {
              return {
                data: null,
                error: {
                  message:
                    'duplicate key value violates unique constraint "integration_grants_user_id_integration_key"',
                  code: '23505',
                },
              };
            }
          }
        }

        const inserted = this.insertRows.map((row) => {
          const full = {
            id: randomUUID(),
            created_at: new Date(1_700_000_000_000 + this.nextSeq()).toISOString(),
            ...row,
          };
          rowsFor(this.table).push(full);
          return full;
        });
        return this.returning
          ? this.applyTerminal(inserted)
          : { data: null, error: null };
      }

      case 'update': {
        const updated: Array<Record<string, unknown>> = [];
        for (const row of rowsFor(this.table)) {
          if (this.matches(row)) {
            Object.assign(row, this.patch ?? {});
            updated.push(row);
          }
        }
        return this.returning
          ? this.applyTerminal(updated)
          : { data: null, error: null };
      }

      case 'delete': {
        const rows = rowsFor(this.table);
        const removed = rows.filter((r) => this.matches(r));
        const keep = rows.filter((r) => !this.matches(r));
        if (this.table === 'tasks') state.tasks = keep as unknown as FakeTask[];
        else if (this.table === 'messages') state.messages = keep as unknown as FakeMessage[];
        else if (this.table === 'reminders') state.reminders = keep as unknown as FakeReminder[];
        else if (this.table === 'users') state.users = keep as unknown as FakeProfile[];
        else if (this.table === 'memories') state.memories = keep as unknown as FakeMemory[];
        else if (this.table === 'memory_settings') {
          state.memorySettings = keep as unknown as FakeMemorySettings[];
        } else if (this.table === 'memory_extraction_jobs') {
          state.extractionJobs = keep as unknown as FakeExtractionJob[];
        } else if (this.table === 'integration_grants') {
          state.integrationGrants = keep as unknown as FakeGrant[];
        } else if (this.table === 'documents') {
          state.documents = keep as unknown as FakeDocument[];
        } else if (this.table === 'document_chunks') {
          state.documentChunks = keep as unknown as FakeDocumentChunk[];
        } else if (this.table === 'document_processing_jobs') {
          state.documentJobs = keep as unknown as FakeDocumentJob[];
        }
        return this.returning ? this.applyTerminal(removed) : { data: null, error: null };
      }
    }
  }

  // Thenable interface so `await query` resolves like supabase-js.
  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------
// Client factory (mocked in place of supabase.service.ts)
// ---------------------------------------------------------------------------

/**
 * SQL-function emulation for the scheduler (Milestone 2).
 *
 * Mirrors `claim_due_reminders()` / `recover_stale_reminders()` from
 * migration 0003. The bodies are fully SYNCHRONOUS (no awaits), which
 * mirrors the single-statement atomicity of the real SQL: two concurrent
 * `runTick()` calls can never claim the same row — the second one sees
 * the row already flipped to `claimed` (the JS single-thread equivalent
 * of FOR UPDATE SKIP LOCKED).
 */
function fakeRpc(
  fn: string,
  args: Record<string, unknown>,
): { data: unknown; error: { message: string; code?: string } | null } {
  if (fn === 'claim_due_reminders') {
    const limit = Number(args.p_limit ?? 10);
    if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
      return { data: null, error: { message: 'p_limit must be between 1 and 100' } };
    }
    const nowIso = new Date().toISOString();
    const due = state.reminders
      .filter(
        (r) =>
          r.status === 'pending' &&
          r.next_attempt_at <= nowIso &&
          r.attempts < r.max_attempts,
      )
      .sort((a, b) => (a.next_attempt_at < b.next_attempt_at ? -1 : 1))
      .slice(0, limit);

    const claimed = due.map((r) => {
      r.status = 'claimed';
      r.claimed_at = nowIso;
      r.last_attempt_at = nowIso;
      r.attempts += 1;
      // The real SQL joins public.users for the recipient address.
      return { ...r, recipient_email: state.emails.get(r.user_id) ?? null };
    });
    return { data: claimed, error: null };
  }

  if (fn === 'recover_stale_reminders') {
    const staleSeconds = Number(args.p_stale_seconds ?? 300);
    if (!Number.isFinite(staleSeconds) || staleSeconds < 1) {
      return { data: null, error: { message: 'p_stale_seconds must be >= 1' } };
    }
    const cutoff = Date.now() - staleSeconds * 1000;
    const nowIso = new Date().toISOString();
    let count = 0;
    for (const r of state.reminders) {
      if (
        r.status === 'claimed' &&
        r.claimed_at &&
        new Date(r.claimed_at).getTime() < cutoff
      ) {
        if (r.attempts >= r.max_attempts) {
          r.status = 'failed';
          r.failed_at = nowIso;
          r.failure_reason = 'Delivery failed: worker interrupted repeatedly.';
          r.claimed_at = null;
        } else {
          r.status = 'pending';
          r.claimed_at = null;
          r.next_attempt_at = nowIso;
        }
        count += 1;
      }
    }
    return { data: count, error: null };
  }

  /**
   * `match_memories(query_embedding, p_user_id, match_threshold, match_count)`
   * — Milestone 4 vector retrieval. The fake has no real pgvector, so
   * similarity is approximated by token overlap against stored content
   * (good enough to exercise ownership/status filtering, thresholding and
   * bounded results — the exact cosine math lives in the SQL function and
   * is verified against a live DB with the extension installed).
   */
  if (fn === 'match_memories') {
    const userId = String(args.p_user_id ?? '');
    const threshold = Number(args.match_threshold ?? 0.65);
    const count = Math.min(Number(args.match_count ?? 8), 50);
    const category = args.p_category ? String(args.p_category) : null;
    if (!userId) {
      return { data: null, error: { message: 'p_user_id is required', code: 'PGRST202' } };
    }
    const queryTokens = new Set(
      String(args.p_query_text ?? args.query_text ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    const rows = state.memories
      .filter(
        (m) =>
          m.user_id === userId &&
          m.status === 'active' &&
          m.superseded_by == null &&
          m.expired_at == null &&
          m.sensitivity !== 'credential' &&
          (category === null || m.category === category),
      )
      .map((m) => {
        const memTokens = new Set(
          m.content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
        );
        let overlap = 0;
        for (const t of queryTokens) if (memTokens.has(t)) overlap += 1;
        // Hybrid lexical signal (M4.2): a memory containing any query token is
        // a lexical candidate, included even below the vector threshold.
        const lexical = overlap > 0;
        let similarity: number;
        if (forcedMatchSimilarity !== null) {
          // Test hook: force an exact similarity (duplicate/conflict cases).
          similarity = forcedMatchSimilarity;
        } else {
          // The fake has no pgvector: keep the historical default above the
          // chat threshold. Hybrid inclusion is exercised via lexical + the
          // forced-similarity hook.
          similarity = 0.85;
        }
        return {
          memory_id: m.id,
          user_id: m.user_id,
          content: m.content,
          category: m.category,
          similarity,
          lexical,
          created_at: m.created_at,
        };
      })
      .filter((r) => r.lexical || r.similarity >= threshold)
      .sort(
        (a, b) =>
          Number(b.lexical) - Number(a.lexical) || b.similarity - a.similarity,
      )
      .slice(0, count);
    return {
      data: rows.map(({ lexical: _lexical, ...row }) => row),
      error: null,
    };
  }

  /**
   * `claim_memory_extraction_jobs(p_limit)` — Milestone 4 atomic outbox
   * claim (mirrors the FOR UPDATE SKIP LOCKED SQL): recovers stale claims
   * first, then flips pending → claimed, increments attempts, and returns
   * the claimed rows. Synchronous body = single-statement atomicity, so
   * two concurrent calls can never claim the same row.
   */
  if (fn === 'claim_memory_extraction_jobs') {
    const limit = Math.min(Math.max(Number(args.p_limit ?? 5), 1), 20);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    // Recover stale claims (> 300s) first, exactly like the SQL function.
    for (const j of state.extractionJobs) {
      if (j.status === 'claimed' && j.claimed_at && new Date(j.claimed_at).getTime() < nowMs - 300_000) {
        j.status = 'pending';
        j.claimed_at = null;
      }
    }
    const claimed = state.extractionJobs
      .filter((j) => j.status === 'pending')
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .slice(0, limit)
      .map((j) => {
        j.status = 'claimed';
        j.claimed_at = nowIso;
        j.attempts += 1;
        return { ...j };
      });
    return { data: claimed, error: null };
  }

  if (fn === 'recover_stale_extraction_jobs') {
    const staleSeconds = Math.max(Number(args.p_stale_seconds ?? 300), 1);
    const cutoff = Date.now() - staleSeconds * 1000;
    let count = 0;
    for (const j of state.extractionJobs) {
      if (j.status === 'claimed' && j.claimed_at && new Date(j.claimed_at).getTime() < cutoff) {
        j.status = 'pending';
        j.claimed_at = null;
        count += 1;
      }
    }
    return { data: count, error: null };
  }

  /**
   * `match_document_chunks(query_embedding, p_user_id, match_threshold,
   * match_count, p_document_ids)` — Milestone 5 vector retrieval.
   * Token-overlap approximation (no pgvector in the fake) plus a forced
   * similarity hook; ownership + status filtering are real here.
   */
  if (fn === 'match_document_chunks') {
    const userId = String(args.p_user_id ?? '');
    const threshold = Number(args.match_threshold ?? 0.5);
    const count = Math.min(Math.max(Number(args.match_count ?? 8), 1), 50);
    const documentIds = Array.isArray(args.p_document_ids)
      ? args.p_document_ids.map(String)
      : null;
    if (!userId) {
      return { data: null, error: { message: 'p_user_id is required', code: 'PGRST202' } };
    }

    const queryText = String(args.query_text ?? '');
    const queryTokens = new Set(
      queryText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    );
    const rows = state.documentChunks
      .filter((c) => {
        const chunk = state.documents.find((d) => d.id === c.document_id);
        if (!chunk || chunk.user_id !== userId) return false;
        if (chunk.status !== 'ready') return false;
        if (!c.embedding) return false;
        if (documentIds && !documentIds.includes(c.document_id)) return false;
        return true;
      })
      .map((c) => {
        const doc = state.documents.find((d) => d.id === c.document_id);
        const chunkTokens = new Set(
          c.content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean),
        );
        let overlap = 0;
        for (const t of queryTokens) if (chunkTokens.has(t)) overlap += 1;
        const lexical = overlap > 0;
        let similarity: number;
        if (forcedMatchSimilarity !== null) {
          similarity = forcedMatchSimilarity;
        } else {
          similarity = lexical ? 0.85 : 0.25;
        }
        return {
          chunk_id: c.id,
          document_id: c.document_id,
          user_id: c.user_id,
          content: c.content,
          similarity,
          chunk_index: c.chunk_index,
          page_start: c.page_start,
          page_end: c.page_end,
          heading: c.heading,
          section_path: c.section_path,
          char_start: c.char_start,
          char_end: c.char_end,
          original_filename: doc?.original_filename ?? '',
        };
      })
      .filter((r) => r.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, count);
    return { data: rows, error: null };
  }

  if (fn === 'claim_document_processing_jobs') {
    const limit = Math.min(Math.max(Number(args.p_limit ?? 5), 1), 20);
    const nowIso = new Date().toISOString();
    for (const j of state.documentJobs) {
      if (
        j.status === 'claimed' &&
        j.claimed_at &&
        new Date(j.claimed_at).getTime() < Date.now() - 300_000
      ) {
        if (j.attempts >= j.max_attempts) {
          j.status = 'failed';
          j.failed_at = nowIso;
          j.error_message = 'STALE_JOB_ATTEMPTS_EXHAUSTED';
        } else {
          j.status = 'pending';
          j.claimed_at = null;
          j.next_attempt_at = nowIso;
        }
      }
    }
    const claimed = state.documentJobs
      .filter((j) => j.status === 'pending')
      .sort((a, b) => (a.next_attempt_at < b.next_attempt_at ? -1 : 1))
      .slice(0, limit)
      .map((j) => {
        j.status = 'claimed';
        j.claimed_at = nowIso;
        j.attempts += 1;
        return { ...j };
      });
    return { data: claimed, error: null };
  }

  if (fn === 'recover_stale_document_jobs') {
    const staleSeconds = Math.max(Number(args.p_stale_seconds ?? 300), 1);
    const cutoff = Date.now() - staleSeconds * 1000;
    const nowIso = new Date().toISOString();
    let count = 0;
    for (const j of state.documentJobs) {
      if (
        j.status === 'claimed' &&
        j.claimed_at &&
        new Date(j.claimed_at).getTime() < cutoff
      ) {
        if (j.attempts >= j.max_attempts) {
          j.status = 'failed';
          j.failed_at = nowIso;
          j.error_message = 'STALE_JOB_ATTEMPTS_EXHAUSTED';
        } else {
          j.status = 'pending';
          j.claimed_at = null;
          j.next_attempt_at = nowIso;
        }
        count += 1;
      }
    }
    return { data: count, error: null };
  }

  return {
    data: null,
    error: { message: `function ${fn}() does not exist`, code: 'PGRST202' },
  };
}

/**
 * Stand-in for `createUserScopedClient(token)`.
 * Returns a client exposing exactly the surface our services use:
 * `auth.getUser`, `from`, and `rpc` (scheduler functions).
 */
export function fakeCreateUserScopedClient(accessToken: string) {
  const client = {
    auth: {
      // Mirrors supabase-js: returns { data: { user }, error } — it never
      // throws for an invalid token.
      getUser: async (token?: string) => {
        const t = token ?? accessToken;
        if (state.expiredTokens.has(t)) {
          return { data: { user: null }, error: { message: 'JWT has expired' } };
        }
        if (state.revokedTokens.has(t)) {
          // Session was revoked (signed out / revoked server-side).
          return {
            data: { user: null },
            error: { message: 'invalid JWT: session has been revoked' },
          };
        }
        const userId = state.validTokens.get(t);
        if (!userId) {
          return { data: { user: null }, error: { message: 'invalid JWT' } };
        }
        const meta = state.userMeta.get(userId);
        return {
          data: {
            user: {
              id: userId,
              email: state.emails.get(userId) ?? null,
              app_metadata: { provider: meta?.provider ?? 'email' },
              user_metadata: {
                full_name: meta?.displayName ?? null,
                avatar_url: meta?.avatarUrl ?? null,
              },
            },
          },
          error: null,
        };
      },
    },
    from: (table: string) => new FakeQuery(table, () => (state.seq += 1)),
    rpc: async (fn: string, args: Record<string, unknown> = {}) => fakeRpc(fn, args),
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, body: Buffer, opts?: { contentType?: string; upsert?: boolean }) {
            const failure = takeStorageFailure('upload');
            if (failure) {
              throw new Error(failure.message);
            }
            storageObjects.set(storageKey(bucket, path), {
              bytes: Buffer.from(body),
              contentType: opts?.contentType ?? 'application/octet-stream',
            });
            return { data: {}, error: null };
          },
          async download(path: string) {
            const failure = takeStorageFailure('download');
            if (failure) {
              throw new Error(failure.message);
            }
            const obj = storageObjects.get(storageKey(bucket, path));
            if (!obj) {
              throw new Error('Object not found');
            }
            return {
              data: new Blob([new Uint8Array(obj.bytes)]),
              error: null,
            };
          },
          async remove(paths: string[]) {
            const failure = takeStorageFailure('remove');
            if (failure) {
              throw new Error(failure.message);
            }
            for (const p of paths) storageObjects.delete(storageKey(bucket, p));
            return { data: {}, error: null };
          },
          async createSignedUrl(path: string, expiresIn: number) {
            const failure = takeStorageFailure('sign');
            if (failure) {
              throw new Error(failure.message);
            }
            return {
              data: { signedUrl: `https://fake.local/${bucket}/${path}?expires=${expiresIn}` },
              error: null,
            };
          },
        };
      },
    },
  };
  // Structural cast: only the used surface matters.
  return client as never;
}
