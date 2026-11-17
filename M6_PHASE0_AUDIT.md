# M6 Phase 0 — Repository Audit and Proposed Architecture

**Milestone:** M6 Multi-Agent Orchestration Engine
**Date:** 2026-11-11
**Branch:** `stabilization/m4.2`, HEAD `d9e9f29` ("M5 Phase 11: deletion lifecycle + 3 tests")
**Status:** Audit complete. **No implementation files have been modified for M6.**

This document is the mandatory Phase 0 deliverable: an audit of the actual
repository state plus the proposed M6 architecture. Implementation begins only
after this document exists.

---

## 1. Verified repository state (measured, not assumed)

| Check | Result |
|---|---|
| Server tests | **459 passed / 459**, 36 test files (re-run at Phase 0 start) |
| Git branch / HEAD | `stabilization/m4.2` @ `d9e9f29` |
| Working tree | 42 entries (26 modified + 16+ untracked) — all uncommitted M5 Phase 12 / report work |
| Migrations present | `0001` … `0012` → **next migration number is `0013`** |
| Frontend tests | None exist (no client test runner, no Playwright) |
| Commit/push | Not performed; will not be performed during M6 without explicit instruction |

The previously reported baseline (459 tests, M5 implementation-complete,
live RAG verification blocked) is confirmed unchanged.

---

## 2. Audit — AI layer

### 2.1 `server/src/services/ai.service.ts` (1036 lines)

- `chat(client, userId, message, sourceMessageId, options?)` is the single
  conversational entry point. Flow: server-side history load
  (`loadRecentHistory`, last 10 rows, `.eq('user_id', …)` + RLS) → time context
  (`dateService.getLocalNowString('Asia/Kolkata')`) → **memory + document
  context injected into the user turn only, never the system prompt** →
  bounded tool loop (`MAX_TOOL_ROUNDS = 3`, `MAX_TOOL_CALLS_PER_ROUND = 5`) →
  `saveMessage` persistence.
- **Registered tools are only two: `create_task` and `save_memory`** — Zod
  schemas plus dispatch are **module-private** (not exported). Tool arguments
  are validated before dispatch; execution goes through the authenticated
  user-scoped client, so ownership is enforced by the service layer.
- Provider fallback is `createCompletionWithFallback` — also **module-private**.
  Exports available for reuse: `GEMINI_OPENAI_BASE_URL`, `DEFAULT_GEMINI_MODEL`
  (`gemini-3.8-flash`), `OLLAMA_OPENAI_BASE_URL`, `DEFAULT_OLLAMA_MODEL`
  (`mistral:latest`), `lastUsedProvider`, `MAX_TOOL_ROUNDS`,
  `MAX_TOOL_CALLS_PER_ROUND`, `AiServiceError`, `matchAiError`, `ChatTurn`,
  `loadRecentHistory`, `saveMessage`, `chat`.
- System prompt (`server/src/prompts/system.prompt.ts`) holds the standing
  rules; untrusted retrieved content stays in the user turn — this isolation
  must be preserved by agents.
- **No agent, orchestrator, planner or workflow code exists anywhere** in the
  repo (grep for agent/orchestrat/workflow/plan returns only unrelated hits).

### 2.2 Implication for M6

The provider abstraction, tool-validation pattern and fallback logic must be
**extracted and reused**, not copied. Phase 1 will export a shared completion +
tool-contract layer from the AI service so orchestrator and agents share one
provider path (Gemini primary, Ollama fallback) with one authorization rule.

---

## 3. Audit — reusable domain services (the M6 execution layer)

| Domain | File | Key exports / behavior |
|---|---|---|
| Memory | `server/src/services/memory.service.ts` | `retrieveMemories` (RPC `match_memories`, hybrid lexical, safe empty fallback), `createMemory` (credential blocking `CREDENTIAL_BLOCKED`, embedding-before-write, conflict detection), `MemoryServiceError` codes; consent/sensitivity and superseded flags respected |
| Tasks | task service/controller | create/update/delete/complete/list with Zod validation; ownership enforced per query |
| Reminders | reminder service + worker | create/reschedule/cancel/list; deterministic date resolution via `dateService` (Asia/Kolkata) |
| Dates | `server/src/services/date.service.ts` | `getLocalNowString('Asia/Kolkata')` etc. — LLM never owns timestamps |
| Documents/RAG | `server/src/services/documents/*` | `searchDocumentChunks` (retrieval), `createDocument`/`deleteDocument`/`getDocumentViewLink`, `citation.service` validation; extraction/chunking/embedding pipeline |
| Providers | `ai.service.ts` (above) | Gemini primary / Ollama Mistral fallback, provider tracking |

**Conclusion:** every agent in Modules B (Memory, Knowledge, Task, Scheduling)
can be a thin, capability-scoped adapter over an existing service. No agent may
open arbitrary table access; agents receive the same user-scoped Supabase
client the controllers use.

---

## 4. Audit — backend infrastructure

- **Auth:** per-router middleware enforces Google OAuth session → `userId`;
  `createUserScopedClient` yields an RLS-bound client. No RBAC beyond
  ownership; a rate-limit helper exists but is not mounted on `/api/chat`.
- **App wiring:** `server/src/app.ts` mounts `/api/chat`, `/api/tasks`,
  `/api/reminders`, `/api/me`, `/api/integrations`, `/api/memories`,
  `/api/documents` — an `/api/agents` router will be added here in Phase 4/6.
- **Workers:** `server/src/worker.ts` + `server/src/workers/*` use SQL claim
  functions (`claim_due_reminders`, `claim_memory_extraction_jobs`,
  `claim_document_processing_jobs`) with `FOR UPDATE SKIP LOCKED`,
  `available_at` backoff and `recover_stale_*` for restart recovery. Job
  payloads store **ids only, never embeddings/content**. This exact idiom will
  be mirrored for workflow recovery in Phase 7 (no new queue technology).
- **Config:** env read via config modules (e.g. `documents.config.ts`);
  missing required config causes fail-fast at startup. Same pattern for M6
  config.
- **No Redis, no Neo4j, no message broker** — and none will be added.

---

## 5. Audit — database and migrations

- Files `0001`–`0012` (init, auth hardening, reminders, Google auth +
  `integration_grants`, memory engine + vector indexes, dedupe, match_memories
  variants, service-role worker grants, documents schema, private storage).
- Established idioms to follow in `0013`:
  - `ENABLE ROW LEVEL SECURITY` + policies `auth.uid() = user_id` for all four
    operations.
  - `set_updated_at()` triggers, foreign keys, partial indexes, enum types for
    status columns.
  - Claim/recovery RPC functions with `SKIP LOCKED`, worker-only `SECURITY
    DEFINER` grants restricted by role, documented in `0010` style.
- **No agent/workflow/approval tables exist** (grep confirmed) — all three M6
  tables are new, in a single migration `0013_agent_workflows.sql`.

---

## 6. Audit — integrations availability (critical for honesty)

| Capability | Actual state | M6 consequence |
|---|---|---|
| Resend email | Exists, **reminders only** (mock mode without API key) | Not a general send-email integration |
| Gmail API | **Absent** (Google OAuth login ≠ Gmail authorization; `integration_grants` scopes exist but no Gmail client) | Communication Agent can only **draft**; sending reported unavailable |
| Calendar / WhatsApp / YouTube | **Absent** | Out of scope (M7); reported unavailable |
| Web-search provider | **Absent** (no serp/tavily/bing/duckduckgo/fetch-search code) | Research Agent can only organize already-available personal context; live search reported unavailable |
| Ollama | Code support exists; no local Ollama configuration in this environment | Fallback tested with mocks; live fallback unverified |

Phase 9 will therefore register Research and Communication as
**draft/architecture-only capabilities** whose "execute" operations return a
structured `CAPABILITY_UNAVAILABLE` result — never fake results.

---

## 7. Audit — frontend and tests

- **Frontend:** Next.js App Router, effectively a **single dashboard page**
  `client/src/app/page.tsx` (chat left pane + section panels right), plus
  `/login`, `/auth/callback`, `/documents/[id]`. **There is no sidebar/nav
  component anywhere** — the section switcher lives inline in `page.tsx`.
  State via Zustand stores (`client/src/store/*`), shared types in
  `client/src/types.ts`, API calls through typed fetch helpers.
  → The **Agent Activity** section must be added as a new section entry in
  `page.tsx` plus a new store (`useAgentStore`) and components under
  `client/src/components/agents/`, preserving all existing sections.
- **Tests:** 36 server vitest files, 459 tests. Helpers:
  `server/tests/helpers/fakeSupabase.ts` (table/RPC-mocking Supabase client)
  and `server/tests/helpers/geminiMocks.ts` (OpenAI-compatible completion
  mocks). New agent tests will use these — no live APIs in regression tests.
- No client-side test runner exists; frontend verification is via
  `tsc --noEmit` + `next build`, plus server-side tests for all API contracts.

---

## 8. Prompt-injection and trust boundaries (audit summary)

- Chat already treats history, memory context and document context as
  untrusted user-turn data; the system prompt carries standing rules.
- M5 added citation validation and injection tests for documents.
- M6 must extend the same treatment to: retrieved memories, agent outputs and
  tool responses. Model-supplied IDs are **never trusted** — they are resolved
  server-side against the authenticated user's ownership before any call.

---

## 9. Proposed M6 architecture

### 9.1 Directory layout (new code under `server/src/agents/`)

```
server/src/agents/
├── shared/            # AgentInput/AgentContext/AgentResult types, Zod plan
│                      # schemas, result helpers, error codes (Phase 1)
├── registry/
│   └── agent.registry.ts        # agents + capabilities, permissions,
│                                # health, duplicate/unavailable rejection (Phase 2)
├── workflow/
│   ├── workflow.store.ts        # durable state in Postgres (Phase 3)
│   ├── workflow.state.ts        # state machine + legal transitions (Phase 3)
│   └── recovery.ts              # stale-run recovery, resume (Phase 7)
├── orchestrator/
│   └── orchestrator.service.ts  # intent → plan → dispatch → verify (Phase 4)
├── approvals/
│   └── approval.service.ts      # HITL records, single-use, expiry (Phase 6)
├── tools/
│   └── agent.tools.ts           # allowlisted capability tools, Zod in/out,
│                                # owner-scoped execution (Phase 6)
├── memory/     memory.agent.ts          (Phase 5)
├── knowledge/  knowledge.agent.ts       (Phase 5)
├── task/       task.agent.ts            (Phase 5)
├── scheduling/ scheduling.agent.ts      (Phase 5)
├── research/   research.agent.ts        (Phase 9, architecture-first)
└── communication/ communication.agent.ts (Phase 9, draft-only)
```

Plus: `server/src/routes/agent.routes.ts` + controller (Phase 4/6/8),
migration `0013_agent_workflows.sql` (Phase 3), frontend
`client/src/components/agents/*` + `useAgentStore` (Phase 8), evaluation
`server/tests/agents-*.test.ts` and `server/scripts/`-style evaluation report
(Phase 10).

### 9.2 Core interfaces (Phase 1)

```typescript
interface Agent {
  name: AgentName;                       // registry-validated
  canHandle(input: AgentInput): Promise<boolean>;
  execute(input: AgentInput, ctx: AgentContext): Promise<AgentResult>;
}
```

- `AgentInput`: Zod-validated operation + args (no free-form tables).
- `AgentContext`: authenticated `userId`, user-scoped Supabase client, run/step
  ids, deadline, shared read-only services, logger.
- `AgentResult`: structured `{ status: 'ok' | 'failed' | 'unavailable' |
  'needs_approval', output, citations?, error? }`.
- Plan schema (Zod): workflow id, user objective, tasks
  (`agent`, `operation`, `args`, `dependsOn[]`, `approvalRequired`,
  `timeoutMs`, `idempotent`), execution order, state.

### 9.3 Orchestrator (Module A)

1. Authenticated request in → **triage**: ordinary questions keep using the
   existing `chat()` path unchanged; only coordinated/multi-step requests enter
   orchestration (a cheap intent check via the shared provider with a
   deterministic fallback rule — no workflow for simple messages).
2. Plan generation: model proposes a plan **restricted to registry
   capabilities**; the plan is Zod-validated and every `agent`/`operation` must
   resolve in the registry or the plan is rejected (model cannot invent
   backend functions).
3. Dependency-ordered execution: sequential by default, bounded parallel only
   for independent read-only steps; per-step timeout, retry with backoff for
   *idempotent* steps only, idempotency keys, cancellation, partial-failure
   → `partially_failed` with a truthful per-step report.
4. Verification: a step's success is the **backend result** (e.g. task id
   returned by `createTask`), never the model's claim.
5. Response: distinguishes planned / approved / executed / failed.

### 9.4 Registry (Module C)

Capability metadata per capability: name, owning agent, operations, required
permissions, `approvalRequired`, input/output Zod schemas, timeout,
`idempotent`, health. Registration is idempotent-guarded (duplicate → error),
unknown/unavailable → rejected with `CAPABILITY_UNAVAILABLE`. The orchestrator
can only dispatch what the registry exposes.

### 9.5 Workflow persistence — migration `0013_agent_workflows.sql`

- `agent_runs` — id (uuid), `user_id` (FK, NOT NULL), objective, status enum
  (`pending, planning, running, waiting_approval, completed, partially_failed,
  failed, cancelled`), summary jsonb, error jsonb, timestamps. RLS
  `auth.uid() = user_id`, `set_updated_at()`, indexes on `(user_id, status)`.
- `agent_run_steps` — id, run FK (cascade), agent, operation, status enum
  (`pending, ready, running, waiting_approval, completed, failed, skipped,
  cancelled`), `depends_on text[]`, input/output **metadata** jsonb (bounded,
  redacted — no secrets, no full prompt text), `retry_count`, timing, error.
- `agent_approvals` — id, run FK, step FK, `user_id`, action description,
  `payload_hash` (exact approved payload), status (`pending, approved, rejected,
  expired, consumed`), `expires_at`, decided-at. Single-use enforced by
  conditional update; approval is valid only for the same user + step + hash.
- Worker-style recovery: stale `running` runs/steps (heartbeat > timeout) are
  recoverable via a `recover_stale_agent_runs()` RPC mirroring the existing
  claim/recovery idiom — no new queue technology.

### 9.6 Human-in-the-loop approval (Module F)

Flow: agent prepares → orchestrator validates → insert `agent_approvals` → run
enters `waiting_approval` → frontend shows exact operation (recipient,
content, data change) → user approves/rejects via authenticated API → backend
verifies user match + step + payload hash + not expired + not consumed →
execute → record result. An LLM statement "the user approved" is never
authorization. Ordinary task/reminder creation stays non-blocking
confirmation-consistent with the existing app; sensitive/destructive/external
actions require approval.

### 9.7 Security model (Module G)

- Identity: agents only ever see the caller's `userId`-scoped client.
- Never trust model IDs: any id coming from model output is resolved by a
  service query filtered by owner, or rejected.
- Tool allowlist + Zod validation; no raw SQL, no filesystem/URL access, no
  arbitrary external calls.
- Retrieved content (memories/documents/search) is untrusted reference data
  confined to user-turn context; agent output cannot override system rules.
- One shared provider abstraction with the existing bounded-round limits — no
  unbounded agent loops (global step budget + per-run deadline).
- Secrets never enter logs/approval payloads/history — metadata is redacted.

### 9.8 Frontend (Module J)

New "Agent Activity" entry in the `page.tsx` section switcher (nav order:
Chat, Memory, Tasks, Reminders, Knowledge Base, **Agent Activity**, Settings —
existing sections untouched). Dashboard lists active/completed/failed runs and
pending approvals; detail view renders the step sequence; approval modal shows
exact payload with approve/reject wired to backend APIs. New Zustand store
follows existing store patterns. Verification = client typecheck + client
build (no client test runner exists).

### 9.9 Evaluation (Module K)

20 deterministic scenarios (single-agent, memory+task, knowledge+memory,
knowledge+task+scheduling, ordering, bounded parallel, recovery, Ollama
fallback, approval required/rejected/expired, duplicate prevention,
cancellation, cross-user isolation, memory/document prompt injection, missing
integrations, partial failure, worker restart, status consistency) as server
vitest tests using `fakeSupabase` + `geminiMocks`. Metrics (workflow success
rate, step success rate, approval enforcement, duplicate prevention, latency,
recovery) computed from real test/run data only — **no fabricated numbers**;
live-verified status reported honestly.

---

## 10. Phase plan and gates

| Phase | Deliverable | Primary tests |
|---|---|---|
| 0 | This audit + architecture | — (baseline 459 re-verified) |
| 1 | `agents/shared/` types + Zod schemas, extract/reuse provider + tool-contract layer from `ai.service.ts` | schema unit tests; full regression |
| 2 | Registry + capability metadata/permissions | registry tests (duplicate, unavailable, permission) |
| 3 | Migration `0013` + workflow store + state machine | persistence/state-transition tests |
| 4 | Orchestrator + triage (simple chat untouched) | orchestrator tests |
| 5 | Memory, Knowledge, Task, Scheduling agents | per-agent unit tests |
| 6 | Approvals + allowlisted tool execution | approval lifecycle tests |
| 7 | Recovery, retry, cancellation, partial failure | recovery/idempotency tests |
| 8 | Frontend Agent Activity + approvals UI | typecheck + build; API contract tests |
| 9 | Research/Communication as available-capability-only | unavailable-capability tests |
| 10 | Security evaluation + evaluation suite (20 scenarios) | security/injection/isolation tests |
| 11 | `MILESTONE_6_REPORT.md` + final six-gate run | full regression |

**Gates after every phase:** server tests (baseline 459 preserved), server
source typecheck, server test typecheck, client typecheck, server build,
client build. No commit/push. No M7 integrations, no Redis/Neo4j, no new
third-party services.

---

## 11. Outstanding issues / open risks

1. **M5 live verification still blocked** (missing `SUPABASE_SERVICE_ROLE_KEY`,
   `EVAL_USER_ID`, `EVAL_CONFIRM`) — M6 live end-to-end runs against real
   Supabase will face the same constraint; regression tests stay mock-based.
2. All M5 work is uncommitted; the working tree has 42 changed/untracked
   entries. M6 will add to this — no commits without instruction.
3. `createCompletionWithFallback` and the tool schemas are module-private;
   Phase 1 must refactor carefully to avoid changing `chat()` behavior (459
   tests must stay green).
4. Research/Communication execution capabilities are unavailable (no
   web-search, no Gmail/messaging API) — architecture only, reported as
   unavailable.
5. No client test runner — frontend behavior verified via typecheck, build and
   server-side API tests only.
