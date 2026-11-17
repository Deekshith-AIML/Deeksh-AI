/**
 * scripts/m61/section3.ts — Phase 6.1 §3: MULTI-USER RLS (LIVE).
 *
 * Runs two REAL GoTrue-authenticated users (A = api-a@m61.test,
 * B = api-b@m61.test) against the isolated local stack and verifies, over
 * actual authenticated requests, that:
 *
 *   Part A — PostgREST directly (RLS is the enforcement point):
 *     A sees only A's approvals/runs/audit; B sees none of A's rows;
 *     B cannot insert/update/delete A's rows (403 or 0 rows);
 *     an anon (role=anon) token sees 0 rows;
 *     even the OWNER cannot update/delete audit events (append-only);
 *   Part B — the real Express API (requireAuth + owner-scoped service):
 *     401 without a token; cross-user reads/decisions are 404 (identical
 *     to a missing id — unprobeable); a body-borne user_id is a 400 and
 *     leaves state untouched.
 *
 * Service-role access is deliberately NOT used as proof anywhere here:
 * every assertion is made through a user's own JWT (or anon), with
 * ground-truth confirmation straight from PostgreSQL via psql.
 *
 * Run (from server/):  node node_modules\tsx\dist\cli.mjs scripts\m61\section3.ts
 */

import './common.js';

import {
  section,
  check,
  evidence,
  note,
  finish,
  rows,
  count,
  approvalStatus,
  taskExists,
  ensureTokens,
  clientFor,
  ensureStub,
  seedPausedRun,
  SHIM_URL,
  USER_A,
  USER_B,
} from './common.js';
import request from 'supertest';
import app from '../../src/app.js';

interface RestResult {
  status: number;
  body: unknown;
}

async function rest(
  method: string,
  pathAndQuery: string,
  token: string,
  body?: unknown,
): Promise<RestResult> {
  const res = await fetch(`${SHIM_URL}/rest/v1${pathAndQuery}`, {
    method,
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: process.env['SUPABASE_ANON_KEY'] ?? '',
      Prefer: 'return=representation',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* raw */
  }
  return { status: res.status, body: parsed };
}

function asArray(body: unknown): unknown[] {
  return Array.isArray(body) ? body : [];
}

async function main(): Promise<void> {
  section('§3 environment');
  await ensureStub(); // seeds below run the REAL orchestrator (needs LLM stub)
  const tokens = await ensureTokens();
  const clientA = clientFor(tokens.a);
  const clientB = clientFor(tokens.b);
  note('stack', 'local shim only — no remote Supabase URL in this process');

  const seed = await seedPausedRun(clientA, 'M61 §3 cross-user target task');
  check('§3 seed: run paused on approval gate', seed.paused, `run=${seed.runId} approval=${seed.approvalId}`);
  check('§3 seed: task still exists (no side effect before decision)', taskExists(seed.taskId));

  // -------------------------------------------------------------------------
  section('§3A — PostgREST with real user JWTs (RLS is the enforcement point)');
  // -------------------------------------------------------------------------

  const aApprovals = await rest('GET', '/agent_approvals?select=id,user_id,status', tokens.a);
  const aRows = asArray(aApprovals.body) as Array<{ id: string; user_id: string }>;
  check(
    'A sees exactly the approval it owns',
    aApprovals.status === 200 && aRows.some((r) => r.id === seed.approvalId && r.user_id === USER_A),
    `rows=${aRows.length}`,
  );

  const bApprovals = await rest('GET', '/agent_approvals?select=id,user_id', tokens.b);
  check('B sees ZERO of A\'s approvals', bApprovals.status === 200 && asArray(bApprovals.body).length === 0,
    `rows=${asArray(bApprovals.body).length}`);

  const aRuns = await rest('GET', '/agent_runs?select=id,user_id', tokens.a);
  check('A sees its own run', asArray(aRuns.body).some((r) => (r as { id: string }).id === seed.runId),
    `rows=${asArray(aRuns.body).length}`);

  const bRuns = await rest('GET', '/agent_runs?select=id', tokens.b);
  check('B sees ZERO of A\'s runs', asArray(bRuns.body).length === 0,
    `rows=${asArray(bRuns.body).length}`);

  const bSteps = await rest('GET', '/agent_run_steps?select=id', tokens.b);
  check('B sees ZERO of A\'s steps', asArray(bSteps.body).length === 0,
    `rows=${asArray(bSteps.body).length}`);

  const bForgeRun = await rest('POST', '/agent_runs', tokens.b, {
    user_id: USER_A,
    objective: 'forged by B',
    status: 'pending',
    summary: {},
  });
  check('B forging a run with user_id=A is rejected by RLS (403)', bForgeRun.status === 403,
    `status=${bForgeRun.status}`);
  check('forged run did not appear', count(`SELECT * FROM agent_runs WHERE objective = 'forged by B'`) === 0);

  const bForgeTask = await rest('POST', '/tasks', tokens.b, {
    user_id: USER_A,
    title: 'forged task by B',
    status: 'todo',
    priority: 'medium',
  });
  check('B forging a task with user_id=A is rejected by RLS (403)', bForgeTask.status === 403,
    `status=${bForgeTask.status}`);

  const bPatch = await rest(
    'PATCH',
    `/agent_approvals?id=eq.${seed.approvalId}`,
    tokens.b,
    { status: 'approved' },
  );
  check('B cannot update A\'s approval (0 rows)', asArray(bPatch.body).length === 0,
    `rows=${asArray(bPatch.body).length}`);
  check('A\'s approval still pending after B\'s update attempt', approvalStatus(seed.approvalId) === 'pending',
    `status=${approvalStatus(seed.approvalId)}`);

  const bDelete = await rest('DELETE', `/agent_approvals?id=eq.${seed.approvalId}`, tokens.b);
  check('B cannot delete A\'s approval (0 rows)', asArray(bDelete.body).length === 0,
    `rows=${asArray(bDelete.body).length}`);
  check('A\'s approval row still exists', approvalStatus(seed.approvalId) !== '<missing>');

  const aAudit = await rest('GET', '/agent_audit_events?select=id,event', tokens.a);
  const aAuditRows = asArray(aAudit.body) as Array<{ id: string; event: string }>;
  check('A sees its own audit events', aAuditRows.length >= 1, `rows=${aAuditRows.length}`);

  const bAudit = await rest('GET', '/agent_audit_events?select=id', tokens.b);
  check('B sees ZERO of A\'s audit events', asArray(bAudit.body).length === 0,
    `rows=${asArray(bAudit.body).length}`);

  const firstAuditId = aAuditRows[0]?.id;
  if (firstAuditId) {
    const auditBefore = rows<{ outcome: string | null }>(
      `SELECT outcome FROM agent_audit_events WHERE id = '${firstAuditId}'`,
    );
    const aPatchAudit = await rest('PATCH', `/agent_audit_events?id=eq.${firstAuditId}`, tokens.a, {
      outcome: 'tampered-by-owner',
    });
    check('OWNER cannot update own audit event (append-only: 0 rows)', asArray(aPatchAudit.body).length === 0,
      `rows=${asArray(aPatchAudit.body).length}`);
    const auditAfter = rows<{ outcome: string | null }>(
      `SELECT outcome FROM agent_audit_events WHERE id = '${firstAuditId}'`,
    );
    check('audit row unchanged in the database',
      JSON.stringify(auditBefore) === JSON.stringify(auditAfter), JSON.stringify(auditAfter));

    const aDeleteAudit = await rest('DELETE', `/agent_audit_events?id=eq.${firstAuditId}`, tokens.a);
    check('OWNER cannot delete own audit event (append-only: 0 rows)', asArray(aDeleteAudit.body).length === 0,
      `rows=${asArray(aDeleteAudit.body).length}`);
    check('audit row still present', count(`SELECT * FROM agent_audit_events WHERE id = '${firstAuditId}'`) === 1);
  }

  const anon = process.env['SUPABASE_ANON_KEY'] ?? '';
  const anonSigned = anon; // legacy-style anon JWT (role=anon)
  const anonAudit = await rest('GET', '/agent_audit_events?select=id', anonSigned);
  check('anon (role=anon) token sees ZERO approval/audit rows',
    asArray(anonAudit.body).length === 0 && anonAudit.status === 200,
    `status=${anonAudit.status} rows=${asArray(anonAudit.body).length}`);
  const anonApprovals = await rest('GET', '/agent_approvals?select=id', anonSigned);
  check('anon token sees ZERO approvals', asArray(anonApprovals.body).length === 0,
    `rows=${asArray(anonApprovals.body).length}`);

  // -------------------------------------------------------------------------
  section('§3B — real Express API (requireAuth + owner-scoped service)');
  // -------------------------------------------------------------------------

  const noAuth = await request(app).get('/api/approvals');
  check('API without a token → 401', noAuth.status === 401, `status=${noAuth.status}`);

  const listA = await request(app)
    .get('/api/approvals')
    .set('Authorization', `Bearer ${tokens.a}`);
  const listABody = listA.body as { approvals?: Array<{ id: string }> };
  check('A lists its approval over HTTP → 200 with the row',
    listA.status === 200 && (listABody.approvals ?? []).some((x) => x.id === seed.approvalId),
    `status=${listA.status} rows=${(listABody.approvals ?? []).length}`);

  const listB = await request(app)
    .get('/api/approvals')
    .set('Authorization', `Bearer ${tokens.b}`);
  const listBBody = listB.body as { approvals?: Array<{ id: string }> };
  check('B listing approvals sees none of A\'s',
    listB.status === 200 && (listBBody.approvals ?? []).every((x) => x.id !== seed.approvalId),
    `rows=${(listBBody.approvals ?? []).length}`);

  const getA = await request(app)
    .get(`/api/approvals/${seed.approvalId}`)
    .set('Authorization', `Bearer ${tokens.a}`);
  check('A reads its approval detail → 200', getA.status === 200, `status=${getA.status}`);

  const missingId = '00000000-0000-0000-0000-000000000099';
  const getB = await request(app)
    .get(`/api/approvals/${seed.approvalId}`)
    .set('Authorization', `Bearer ${tokens.b}`);
  const getMissing = await request(app)
    .get(`/api/approvals/${missingId}`)
    .set('Authorization', `Bearer ${tokens.b}`);
  check('B reading A\'s approval id → 404', getB.status === 404, `status=${getB.status}`);
  check('B reading a missing id → 404 with the IDENTICAL body (no probing)',
    getMissing.status === 404 &&
      JSON.stringify(getMissing.body) === JSON.stringify(getB.body),
    JSON.stringify(getB.body));

  const decideB = await request(app)
    .post(`/api/approvals/${seed.approvalId}/approve`)
    .set('Authorization', `Bearer ${tokens.b}`);
  check('B approving A\'s approval → 404 (identity never leaks)', decideB.status === 404,
    `status=${decideB.status}`);
  check('state untouched after B\'s approve attempt', approvalStatus(seed.approvalId) === 'pending',
    `status=${approvalStatus(seed.approvalId)}`);

  const inject = await request(app)
    .post(`/api/approvals/${seed.approvalId}/approve`)
    .set('Authorization', `Bearer ${tokens.a}`)
    .send({ user_id: USER_B });
  check('body-borne user_id on a decision → 400 (strictly empty body)', inject.status === 400,
    `status=${inject.status}`);
  check('state untouched after identity-injection attempt', approvalStatus(seed.approvalId) === 'pending',
    `status=${approvalStatus(seed.approvalId)}`);

  const badUuid = await request(app)
    .get('/api/approvals/not-a-uuid')
    .set('Authorization', `Bearer ${tokens.a}`);
  check('non-uuid approval id → 400', badUuid.status === 400, `status=${badUuid.status}`);

  const badQuery = await request(app)
    .get('/api/approvals?status=not_a_status')
    .set('Authorization', `Bearer ${tokens.a}`);
  check('invalid list filter → 400', badQuery.status === 400, `status=${badQuery.status}`);

  const bPendingFilter = await request(app)
    .get('/api/approvals?status=pending')
    .set('Authorization', `Bearer ${tokens.b}`);
  const bPendingList = approvalsOf(bPendingFilter.body);
  check('B\'s filtered list is empty (RLS + owner scoping)',
    bPendingFilter.status === 200 && bPendingList.length === 0, `rows=${bPendingList.length}`);

  // -------------------------------------------------------------------------
  section('§3 final state');
  // -------------------------------------------------------------------------
  check('approval still pending after the whole cross-user matrix',
    approvalStatus(seed.approvalId) === 'pending', `status=${approvalStatus(seed.approvalId)}`);
  check('task still exists — no cross-user path executed anything',
    taskExists(seed.taskId));
  check('zero approval executions recorded for the seed run',
    count(`SELECT * FROM agent_audit_events WHERE run_id = '${seed.runId}' AND event = 'approval.consumed'`) === 0);

  evidence('seed run', { runId: seed.runId, approvalId: seed.approvalId, taskId: seed.taskId });
  note('service-role was never used for any assertion above', 'user JWTs + anon JWT only');
}

function approvalsOf(body: unknown): unknown[] {
  const arr = (body as { approvals?: unknown[] })?.approvals;
  return Array.isArray(arr) ? arr : [];
}

main()
  .then(() => finish())
  .catch((err: unknown) => {
    console.error('[section3] fatal:', err);
    process.exitCode = 1;
    finish();
  });
