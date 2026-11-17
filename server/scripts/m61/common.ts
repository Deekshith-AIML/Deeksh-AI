/**
 * scripts/m61/common.ts
 * ---------------------
 * Phase 6.1 (M6.1) live-verification driver library.
 *
 * Every m61 section driver (section3–section6) imports this module FIRST.
 * `./env-boot.js` is this file's first import, so by the time any `src/**`
 * module is evaluated, the process is pinned to the isolated local stack
 * (shim 127.0.0.1:55437, LLM stub 127.0.0.1:55438) and the remote Supabase
 * URL from server/.env can never be used.
 *
 * What lives here:
 *   - PASS/FAIL evidence bookkeeping (honest labels, exit code 1 on failure)
 *   - ground-truth SQL over `docker exec m61-pg psql` (superuser view, used
 *     to record EXACT database states — independent of any application code)
 *   - real GoTrue token acquisition for the two verification users
 *   - LLM stub supervision (spawn if not running)
 *   - fixture seeds that go through the REAL orchestrator (executeObjective)
 *
 * Product code is never modified; privileged SQL is used only to (a) read
 * ground truth and (b) simulate external faults (superuser tampering) that
 * an authenticated API must never be able to perform.
 */

import './env-boot.js';

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  SHIM_URL,
  LLM_STUB_URL,
  USER_A,
  USER_B,
  EMAIL_A,
  EMAIL_B,
  LOCAL_PASSWORD,
  signLocalJwt,
  REPO_ROOT,
} from './env-boot.js';
import { createUserScopedClient } from '../../src/services/supabase.service.js';
import { createDomainRegistry } from '../../src/agents/register.js';
import { executeObjective } from '../../src/agents/orchestrator/orchestrator.service.js';
import { createTask } from '../../src/services/task.service.js';
import * as approvalService from '../../src/agents/approvals/approval.service.js';
import type { AgentApproval } from '../../src/agents/approvals/approval.store.js';
import type { AgentRun, AgentRunStep } from '../../src/agents/workflow/workflow.store.js';

export { SHIM_URL, LLM_STUB_URL, USER_A, USER_B, EMAIL_A, EMAIL_B };

// ---------------------------------------------------------------------------
// Evidence bookkeeping
// ---------------------------------------------------------------------------

export interface CheckRecord {
  section: string;
  name: string;
  pass: boolean;
  detail: string;
}

export const CHECKS: CheckRecord[] = [];
let currentSection = 'm61';

export function section(name: string): void {
  currentSection = name;
  console.log(`\n===== ${name} =====`);
}

/** Record + print one check. Returns the pass value (for chaining). */
export function check(name: string, pass: boolean, detail = ''): boolean {
  CHECKS.push({ section: currentSection, name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

/** Print a labelled evidence blob (JSON, bounded). Never receives secrets. */
export function evidence(label: string, value: unknown): void {
  const json = JSON.stringify(value, null, 0);
  console.log(`  [evidence] ${label}: ${json.length > 3_000 ? `${json.slice(0, 3_000)}…(${json.length} chars)` : json}`);
}

export function note(label: string, value: unknown): void {
  console.log(`  [note] ${label}: ${String(value)}`);
}

/** Print summary, set exit code. Call exactly once at the end of a driver. */
export function finish(): void {
  const failed = CHECKS.filter((c) => !c.pass);
  console.log('\n===== SUMMARY =====');
  console.log(`${CHECKS.length - failed.length}/${CHECKS.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL [${f.section}] ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

export function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run fn and capture {ok, error} instead of throwing. */
export async function attempt(
  fn: () => Promise<unknown>,
): Promise<{ ok: boolean; value?: unknown; error?: unknown }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// ---------------------------------------------------------------------------
// Ground truth via superuser SQL (docker exec m61-pg psql)
// ---------------------------------------------------------------------------

export function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', 'm61-pg', 'psql', '-U', 'postgres', '-d', 'task_assistant', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  ).trim();
}

/** Run an aggregate SELECT that yields json, parse as T[]. */
export function rows<T>(innerSql: string): T[] {
  const out = psql(`SELECT COALESCE(json_agg(t), '[]'::json) FROM (${innerSql}) t;`);
  if (!out) return [];
  return JSON.parse(out) as T[];
}

export function count(innerSql: string): number {
  const out = psql(`SELECT count(*) FROM (${innerSql}) t;`);
  return Number(out || '0');
}

export function scalarText(sql: string): string {
  return psql(sql);
}

// --- Convenience ground-truth readers ---------------------------------------

export function runRow(runId: string): Record<string, unknown> | null {
  const r = rows<Record<string, unknown>>(`SELECT * FROM agent_runs WHERE id = '${runId}'`);
  return r[0] ?? null;
}

export function stepRows(runId: string): Record<string, unknown>[] {
  return rows<Record<string, unknown>>(
    `SELECT id, step_key, agent_name, operation, status, depends_on, requires_approval, retry_count, error_code, error_message, input_metadata, output_metadata, created_at, started_at, completed_at FROM agent_run_steps WHERE run_id = '${runId}' ORDER BY created_at`,
  );
}

/** Compact step_key → status map (exact DB state, easy to assert on). */
export function stepStates(runId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of stepRows(runId)) out[String(s['step_key'])] = String(s['status']);
  return out;
}

export function approvalRow(approvalId: string): Record<string, unknown> | null {
  const r = rows<Record<string, unknown>>(`SELECT * FROM agent_approvals WHERE id = '${approvalId}'`);
  return r[0] ?? null;
}

export function approvalStatus(approvalId: string): string {
  const row = approvalRow(approvalId);
  return row ? String(row['status']) : '<missing>';
}

export function auditRows(runId?: string): Record<string, unknown>[] {
  const where = runId ? `WHERE run_id = '${runId}'` : '';
  return rows<Record<string, unknown>>(
    `SELECT event, approval_id, step_id, outcome, metadata, created_at FROM agent_audit_events ${where} ORDER BY created_at, id`,
  );
}

export function auditCount(runId: string, event: string): number {
  return count(`SELECT * FROM agent_audit_events WHERE run_id = '${runId}' AND event = '${event}'`);
}

export function taskExists(taskId: string): boolean {
  return count(`SELECT * FROM tasks WHERE id = '${taskId}'`) > 0;
}

// ---------------------------------------------------------------------------
// Real GoTrue tokens for the two verification users
// ---------------------------------------------------------------------------

function tokenFile(userId: string): string {
  return path.join(os.tmpdir(), `m61_tok_${userId === USER_A ? 'a' : 'b'}.txt`);
}

async function httpJson(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  return { status: res.status, body };
}

async function verifyWithGoTrue(token: string): Promise<boolean> {
  const { status } = await httpJson(`${SHIM_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return status === 200;
}

/** Set the local user's password through GoTrue's admin API (local stack). */
async function adminSetPassword(userId: string): Promise<boolean> {
  const adminJwt = signLocalJwt(
    { sub: userId, role: 'service_role', iss: 'supabase', aud: 'authenticated' },
    3_600,
  );
  const { status } = await httpJson(`${SHIM_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${adminJwt}`,
      apikey: adminJwt,
    },
    body: JSON.stringify({ password: LOCAL_PASSWORD }),
  });
  return status >= 200 && status < 300;
}

/** Password grant against the REAL local GoTrue (email confirmation off). */
async function passwordGrant(email: string): Promise<string | null> {
  const anon = process.env['SUPABASE_ANON_KEY'] ?? '';
  const { status, body } = await httpJson(`${SHIM_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${anon}`, apikey: anon },
    body: JSON.stringify({ email, password: LOCAL_PASSWORD }),
  });
  if (status !== 200) return null;
  const token = (body as { access_token?: string } | null)?.access_token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

async function ensureToken(userId: string, email: string): Promise<string> {
  const file = tokenFile(userId);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (existing && (await verifyWithGoTrue(existing))) return existing;

  let token: string | null = null;
  if (await adminSetPassword(userId)) {
    token = await passwordGrant(email);
  }
  if (!token) {
    // Fallback: mint a token with the LOCAL stack secret (still verified by
    // GoTrue's /user endpoint before anything trusts it). Recorded as an
    // honest environment note by the caller when this path is used.
    token = signLocalJwt(
      {
        sub: userId,
        role: 'authenticated',
        iss: 'supabase',
        aud: 'authenticated',
        session_id: crypto.randomUUID(),
        user_metadata: {},
        app_metadata: { provider: 'email', providers: ['email'] },
      },
      3_600,
    );
    if (!(await verifyWithGoTrue(token))) {
      throw new Error(`m61: cannot obtain a GoTrue-verified token for ${email}`);
    }
    note('token-path', `password grant unavailable for ${email}; minted local token (verified by GoTrue /user)`);
  }
  fs.writeFileSync(file, token, { encoding: 'utf8' });
  return token;
}

export interface TokenPair {
  a: string;
  b: string;
}

export async function ensureTokens(): Promise<TokenPair> {
  const a = await ensureToken(USER_A, EMAIL_A);
  const b = await ensureToken(USER_B, EMAIL_B);
  return { a, b };
}

/** Fresh user-scoped client (mirrors one HTTP request's client in prod). */
export function clientFor(token: string): SupabaseClient {
  return createUserScopedClient(token);
}

// ---------------------------------------------------------------------------
// LLM stub supervision
// ---------------------------------------------------------------------------

export async function ensureStub(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${LLM_STUB_URL}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (i === 0) {
      const stubPath = path.join(REPO_ROOT, 'supabase', 'local-dev', 'm61-llm-stub.mjs');
      const child = spawn(process.execPath, [stubPath], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      note('llm-stub', 'spawned m61-llm-stub.mjs on 127.0.0.1:55438');
    }
    await waitMs(400);
  }
  const res = await fetch(`${LLM_STUB_URL}/health`).catch(() => null);
  if (!res || !res.ok) throw new Error('m61: LLM stub is not reachable on 127.0.0.1:55438');
}

/** How many model calls the stub has served (evidence). */
export async function stubRequests(): Promise<{ count: number; requests: unknown[] }> {
  const res = await fetch(`${LLM_STUB_URL}/requests`);
  return (await res.json()) as { count: number; requests: unknown[] };
}

// ---------------------------------------------------------------------------
// Fixture seeds (REAL orchestrator against the local DB)
// ---------------------------------------------------------------------------

export interface PausedSeed {
  taskId: string;
  runId: string;
  /** The approval-gated (task.delete) step. */
  stepId: string;
  approvalId: string;
  paused: boolean;
  planAgents: string[];
}

/**
 * Create a task for user A and run the REAL orchestrator until it pauses on
 * the task.delete approval gate. Requires the LLM stub (ensureStub()).
 */
export async function seedPausedRun(
  client: SupabaseClient,
  title: string,
): Promise<PausedSeed> {
  const task = await createTask(client, USER_A, {
    title,
    priority: 'medium',
    status: 'todo',
  });
  const registry = createDomainRegistry();
  const result = await executeObjective(
    client,
    USER_A,
    `Delete task ${task.id} right now, then list tasks`,
    registry,
  );
  const steps = rows<{ id: string; step_key: string; operation: string; status: string }>(
    `SELECT id, step_key, operation, status FROM agent_run_steps WHERE run_id = '${result.runId}' AND operation = 'delete'`,
  );
  const step = steps[0];
  if (!step) throw new Error('m61 seed: no delete step persisted');
  const approvals = rows<{ id: string }>(
    `SELECT id FROM agent_approvals WHERE run_id = '${result.runId}' AND step_id = '${step.id}' ORDER BY created_at DESC`,
  );
  const approvalId = approvals[0]?.id;
  if (!approvalId) throw new Error('m61 seed: no approval persisted');
  return {
    taskId: task.id,
    runId: result.runId,
    stepId: step.id,
    approvalId,
    paused: result.status === 'waiting_approval' && step.status === 'waiting_approval',
    planAgents: [...new Set(result.plan.steps.map((s) => s.agent))],
  };
}
