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

interface FakeState {
  /** token → userId for tokens considered VALID by auth.getUser. */
  validTokens: Map<string, string>;
  /** Tokens explicitly marked expired (auth.getUser returns an error). */
  expiredTokens: Set<string>;
  /** userId → email (for getUser responses). */
  emails: Map<string, string>;
  tasks: FakeTask[];
  messages: FakeMessage[];
  /** Monotonic counter for deterministic created_at ordering. */
  seq: number;
  /** Injected DB failures consumed on the next matching operation. */
  failures: Array<{ table: string; op: string; message: string }>;
}

const state: FakeState = {
  validTokens: new Map(),
  expiredTokens: new Set(),
  emails: new Map(),
  tasks: [],
  messages: [],
  seq: 0,
  failures: [],
};

/** Register a user + bearer token that `auth.getUser` will accept. */
export function registerUser(token: string, userId: string, email: string): void {
  state.validTokens.set(token, userId);
  state.emails.set(userId, email);
}

/** Mark a previously registered token as expired (auth.getUser errors). */
export function expireToken(token: string): void {
  state.validTokens.delete(token);
  state.expiredTokens.add(token);
}

/** Make the next matching table/op fail with a DB error. */
export function injectDatabaseFailure(table: string, op: string, message = 'simulated database failure'): void {
  state.failures.push({ table, op, message });
}

/** Reset all in-memory data between tests. */
export function resetFakeSupabase(): void {
  state.validTokens.clear();
  state.expiredTokens.clear();
  state.emails.clear();
  state.tasks = [];
  state.messages = [];
  state.seq = 0;
  state.failures = [];
}

/** Direct access for seeding/assertions in tests. */
export const fakeDb = {
  get tasks() {
    return state.tasks;
  },
  get messages() {
    return state.messages;
  },
};

/** Return the backing array for a supported table (structurally typed). */
function rowsFor(table: string): Array<Record<string, unknown>> {
  if (table === 'tasks') return state.tasks as unknown as Array<Record<string, unknown>>;
  if (table === 'messages') return state.messages as unknown as Array<Record<string, unknown>>;
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
  private patch: Record<string, unknown> | null = null;
  private insertRows: Array<Record<string, unknown>> = [];
  private orderSpec: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;
  private terminal: 'single' | 'maybeSingle' | null = null;
  private returning = false;

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
 * Stand-in for `createUserScopedClient(token)`.
 * Returns a client exposing exactly the surface our services use:
 * `auth.getUser` and `from`.
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
        const userId = state.validTokens.get(t);
        if (!userId) {
          return { data: { user: null }, error: { message: 'invalid JWT' } };
        }
        return {
          data: { user: { id: userId, email: state.emails.get(userId) ?? null } },
          error: null,
        };
      },
    },
    from: (table: string) => new FakeQuery(table, () => (state.seq += 1)),
  };
  // Structural cast: only the used surface matters.
  return client as never;
}
