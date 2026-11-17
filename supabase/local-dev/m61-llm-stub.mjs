/**
 * m61-llm-stub.mjs — Phase 6.1 (M6.1) local LLM stub for LIVE verification.
 *
 * PURPOSE
 *   Serves OpenAI-compatible `POST /chat/completions` responses on
 *   http://127.0.0.1:55438 so the REAL orchestrator (triage + planning
 *   code paths in orchestrator.service.ts) can run against the local
 *   database WITHOUT any external network calls. The application is pointed
 *   here exclusively via `GEMINI_BASE_URL` — no product code is modified;
 *   this is a transport-level test double (same technique the unit suite
 *   uses, but live over HTTP).
 *
 * BEHAVIOUR
 *   - Triage call (system prompt mentions "classify user requests")
 *     -> {"orchestrate":true}
 *   - Planning call (system prompt mentions "orchestration planner")
 *     -> a fixed, bounded plan:
 *          lookup_tasks (task.list) ->
 *          delete_task  (task.delete, requiresApproval, dependsOn lookup) ->
 *          confirm_cleanup (task.list, dependsOn delete)
 *        with `task_id` extracted from the objective text. Only SAFE
 *        capabilities are ever returned (task.list / task.delete) — the
 *        stub never proposes messaging/scheduling capabilities.
 *   - Unknown call -> {"orchestrate":false} (safe default).
 *
 * AUDIT
 *   Every request is recorded and exposed at `GET /requests` so the
 *   verification report can show exactly how many model calls happened and
 *   which plan JSON was served (evidence, not claims).
 *
 * Run:  node supabase/local-dev/m61-llm-stub.mjs
 * Stop: Ctrl+C  (disposable, local-only, binds 127.0.0.1)
 */

import http from 'node:http';

const PORT = 55438;
const HOST = '127.0.0.1';

/** In-memory request log (evidence endpoint). Bounded. */
const requestLog = [];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function openaiResponse(model, content) {
  return {
    id: 'chatcmpl-m61stub',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'm61-local-stub',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function planForObjective(objective) {
  const taskId = objective.match(UUID_RE)?.[0] ?? null;
  const steps = [
    {
      stepKey: 'lookup_tasks',
      agent: 'task',
      operation: 'list',
      args: {},
      dependsOn: [],
      requiresApproval: false,
    },
  ];
  if (taskId) {
    steps.push(
      {
        stepKey: 'delete_task',
        agent: 'task',
        operation: 'delete',
        args: { task_id: taskId },
        dependsOn: ['lookup_tasks'],
        requiresApproval: true,
      },
      {
        stepKey: 'confirm_cleanup',
        agent: 'task',
        operation: 'list',
        args: {},
        dependsOn: ['delete_task'],
        requiresApproval: false,
      },
    );
  }
  return { objective: objective.slice(0, 900), steps, requiresApproval: false };
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad json' }));
    return;
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages
    .filter((m) => m?.role === 'system')
    .map((m) => String(m?.content ?? ''))
    .join('\n');
  const user = messages
    .filter((m) => m?.role === 'user')
    .map((m) => String(m?.content ?? ''))
    .join('\n');

  let kind = 'unknown';
  let content;

  if (system.includes('classify user requests')) {
    kind = 'triage';
    content = JSON.stringify({ orchestrate: true });
  } else if (system.includes('orchestration planner')) {
    kind = 'plan';
    const objective = user.startsWith('Objective:') ? user.slice('Objective:'.length).trim() : user;
    content = JSON.stringify(planForObjective(objective));
  } else {
    content = JSON.stringify({ orchestrate: false });
  }

  requestLog.push({
    at: new Date().toISOString(),
    kind,
    model: typeof body?.model === 'string' ? body.model : null,
    content,
  });
  if (requestLog.length > 200) requestLog.shift();

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(openaiResponse(body?.model, content)));
}

const server = http.createServer((req, res) => {
  const url = (req.url ?? '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stub: 'm61-llm', port: PORT }));
    return;
  }
  if (req.method === 'GET' && url === '/requests') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: requestLog.length, requests: requestLog }));
    return;
  }
  if (req.method === 'POST' && url.endsWith('/chat/completions')) {
    void handleChatCompletions(req, res);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`[m61-llm-stub] listening on http://${HOST}:${PORT} (OpenAI-compatible /chat/completions)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
