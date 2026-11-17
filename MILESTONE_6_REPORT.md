# MILESTONE 6 REPORT — Multi-Agent Orchestration Engine

**Project:** DEEKSH AI
**Branch:** `stabilization/m4.2` (HEAD `d9e9f29` at start of M6)
**Status:** In progress — Phases 0–6 complete (Phase 6: human approval +
secure execution). Phase 7 not started.
**Rule:** implemented / tested / live-verified / unverified are always
distinguished. No fabricated results. No automatic commits or pushes.

---

## Phase tracking

| Phase | Status | Changed files | Tests | Result | Outstanding |
|---|---|---|---|---|---|
| 0 — Repository audit + architecture | **Complete** | `M6_PHASE0_AUDIT.md` (new doc only; no implementation files touched) | Baseline re-run: **459/459 passed, 36 files** | Audit and proposed architecture documented | See audit §11 |
| 1 — Shared agent interfaces and schemas | **Complete** | New: `server/src/agents/shared/agent.types.ts`, `plan.schema.ts`, `errors.ts`, `index.ts`, `server/tests/agent-plan-schemas.test.ts`. Modified: `server/src/services/ai.service.ts` (exported `createCompletionWithFallback` + `CompletionParams` only — no behavior change) | **484/484 passed, 37 files** (25 new; 459 baseline preserved) | All six gates green: server tests, server typecheck (source+test), client typecheck, server build, client build | None |
| 2 — Agent registry and capability permissions | **Complete** | New: `server/src/agents/registry/agent.registry.ts`, `server/tests/agent-registry.test.ts` | **500/500 passed, 38 files** (16 new; 484 preserved) | All six gates green | None |
| 3 — Workflow persistence and state machine | **Complete** | New: `supabase/migrations/0013_agent_workflows.sql`, `server/src/agents/workflow/workflow.state.ts`, `workflow.store.ts`, `server/tests/agent-workflow-store.test.ts`. Modified: `server/tests/helpers/fakeSupabase.ts` (added `agent_runs`/`agent_run_steps`/`agent_approvals` tables + cascade) | **518/518 passed, 39 files** (18 new; 500 preserved) | All six gates green; migration adds RLS, owner-consistency triggers, CAS-friendly indexes, idempotency unique index, `recover_stale_agent_runs()` (service_role only) | Migration not applied to a live DB (no local Supabase/Docker stack) — SQL verified by inspection only |
| 4 — Central orchestrator | **Complete** | New: `server/src/agents/orchestrator/orchestrator.service.ts`, `server/tests/agent-orchestrator.test.ts`. Modified: `server/src/agents/registry/agent.registry.ts` (`findCapabilityFor`, `validatePlanStep`), `server/src/agents/workflow/workflow.state.ts` (nothing-succeeded → `failed`) | **541/541 passed, 40 files** (23 new; 518 preserved) | All six gates green. Verified: triage defaults to normal chat on any parse/provider failure; registry-gated planning (model cannot invent functions); wave-based dependency execution with bounded parallelism; approval pause; timeout; idempotent-only retry; cancellation; partial failure with dependent skip; idempotency dedupe; cross-user isolation | Approval *records* not yet created (Phase 6); API route not yet exposed (Phase 8) |
| 5 — Memory, Knowledge, Task, Scheduling agents | **Complete** | New: `server/src/agents/memory/memory.agent.ts`, `knowledge/knowledge.agent.ts`, `task/task.agent.ts`, `scheduling/scheduling.agent.ts`, `server/src/agents/register.ts`, `server/src/agents/shared/result.ts`. Modified: `server/src/agents/registry/agent.registry.ts`, `orchestrator/orchestrator.service.ts`, `workflow/workflow.store.ts`, service files (memory, task, reminder, date, documents), `ai.service.ts` (exported `createCompletionWithFallback`/`CompletionParams`), `fakeSupabase.ts`. Tests: `server/tests/agent-domain.test.ts` (35 new tests). No migration changes. | **576/576 passed, 41 files** (25 prior + 35 new; 541 baseline preserved) | All six gates green (server tests, server typecheck incl. fixed FakeMemory embedding cast, client typecheck, server build, client build). Agents wrap existing services; approval-gated ops (`task.delete`, `scheduling.cancel`); idempotency for create/update/list; foreign-id resolution via `getTaskById`/`getReminderById`/`assertSearchableDocumentScope`. | Outstanding: unapplied migration `0013_agent_workflows.sql` to live DB; Phase 6 (approval endpoints & secure execution) not yet implemented; M5 live eval blocked by missing Supabase env keys. |
| 6 — Human approval and secure tool execution | **Complete** | New: `server/src/agents/approvals/canonical.ts`, `approval.store.ts`, `approval.service.ts`, `policy.ts`, `approval.schemas.ts`, `index.ts`, `server/src/controllers/approval.controller.ts`, `server/src/routes/approval.routes.ts`, `server/tests/agent-approvals.test.ts` (27 tests), `server/tests/approval-api.test.ts` (15 tests). Modified: `server/src/agents/orchestrator/orchestrator.service.ts` (StepExecContext, approval gate in `executeStep`, seed-loop evaluation, settlement paths), `server/src/app.ts` (mount `/api/approvals`), `server/src/agents/approvals/approval.store.ts` (expiry audit events), `supabase/migrations/0013_agent_workflows.sql` (extended in place: 8-status CHECK, `executed_at`, `agent_audit_events` append-only table, owner trigger, partial unique pending index — **never applied to any DB**), `server/tests/helpers/fakeSupabase.ts` (audit table, `.gt()`, cascades, `executed_at`) | **618/618 passed, 43 files** (42 new; 576 baseline preserved, zero weakened) | All six gates green: server tests **618/618, 43 files**; server typecheck (source+test) clean; server build clean; client typecheck clean; client build clean (Next.js production); migration/RLS inspection gate PASS (12/12 mechanical checks). All 16 mandated security scenarios covered (S10 over HTTP). | Migration `0013` not applied to a live DB (no Supabase/Docker stack) — SQL inspection only; live-DB RLS/trigger verification unverified; Phase 7 not started |
| 7 — Workflow recovery and error handling | Not started | — | — | — | — |
| 8 — Frontend Agent Activity dashboard | Not started | — | — | — | — |
| 9 — Research/Communication capability integration | Not started | — | — | — | — |
| 10 — Security evaluation and regression tests | Not started | — | — | — | — |
| 11 — Documentation and final verification | Not started | — | — | — | — |

---

## Phase 0 — Repository audit and architecture (2026-11-11)

**Deliverable:** `M6_PHASE0_AUDIT.md` — full repository audit and proposed
M6 architecture. No implementation files were modified.

### Verified baseline (re-measured)

- Server tests: **459 passed / 459** across 36 files.
- Migrations `0001`–`0012` → next migration is **`0013`**.
- Git: `stabilization/m4.2` @ `d9e9f29`; 42 modified/untracked entries, all
  uncommitted M5 work. No commits made for M6.
- No existing agent/orchestration code, no agent/workflow/approval tables, no
  Redis/Neo4j, no sidebar component, no client test runner.

### Key audit findings

- AI layer: `chat()` with bounded tool loop (3 rounds), **only two module-
  private tools** (`create_task`, `save_memory`), private provider fallback —
  Phase 1 must extract/reuse, not duplicate.
- Execution layer exists: memory, task, reminder, date, document retrieval/RAG,
  citation services — all agents wrap these with the user-scoped client.
- Integrations: Resend (reminders only) exists; **Gmail, Calendar, WhatsApp,
  YouTube, web-search are absent** → Research/Communication agents are
  architecture/draft-only and reported unavailable.
- Frontend: single dashboard `client/src/app/page.tsx`; Agent Activity must be
  added as a new section entry there.
- Worker idiom: `SKIP LOCKED` claim + stale recovery RPCs → mirrored for
  workflow recovery in `0013`, no new queue technology.

### Architecture summary (details in audit §9)

New code under `server/src/agents/`: `shared/`, `registry/`, `workflow/`,
`orchestrator/`, `approvals/`, `tools/`, and per-domain agent folders.
Migration `0013_agent_workflows.sql` adds `agent_runs`, `agent_run_steps`,
`agent_approvals` with RLS, status enums, payload-hash single-use approvals.
Simple chat keeps using the existing `chat()` path; only coordinated requests
enter orchestration. Human approval is mandatory for sensitive actions;
model-supplied IDs are never trusted; execution is sequential/bounded-parallel
with timeouts, retry (idempotent only), cancellation and partial-failure
reporting.

### Outstanding issues

1. M5 live Supabase/provider verification still blocked (missing
   `SUPABASE_SERVICE_ROLE_KEY`, `EVAL_USER_ID`, `EVAL_CONFIRM`).
2. All M5 + M6 work remains uncommitted by design.
3. Phase 1 refactor of `ai.service.ts` must keep all 459 tests green.
4. Research live search and Communication sending are unavailable in M6 scope.

---

## Phase 5 — Memory, Knowledge, Task, Scheduling agents (2026-11-12)

**Deliverable:** four domain agents + registry wiring + shared result mapping.

### Implemented

- **Memory agent** (`server/src/agents/memory/memory.agent.ts`): operations
  `retrieve` (owner-scoped retrieval through `retrieveMemories` with category
  filter and bounded excerpts) and `create` (through `createMemory` with
  confidence-driven status and conflict handling).
- **Knowledge agent** (`server/src/agents/knowledge/knowledge.agent.ts`):
  operations `search` (through `searchDocumentChunks` + `assertSearchableDocumentScope`
  for owner + readiness checks on model-supplied document ids, `throwOnError`)
  and `list` (through `listDocuments`).
- **Task agent** (`server/src/agents/task/task.agent.ts`): operations `list`,
  `create` (via `findDuplicateTask` for idempotency), `update`, `delete`
  (owner-scoped through task service).
- **Scheduling agent** (`server/src/agents/scheduling/scheduling.agent.ts`):
  operations `list`, `create` (through `resolveFutureReminderTime` /
  `createReminder` with idempotency key), `update`, `cancel`.
- **Agent registry wiring** (`server/src/agents/register.ts`, registry).
- **Shared result mapping** (`server/src/agents/shared/result.ts`).

### Tests

- `server/tests/agent-domain.test.ts` (35 new tests) added.
- Full server suite re-verified: **576/576 passed, 41 test files** (baseline
  541/40 preserved — only additive agent tests).
- Type fix: `FakeMemory` interface lacked the runtime `embedding` field; test
  access cast via `unknown as Record<string, unknown>`.

### Validation (six gates, re-verified at Phase 5 close)

- Server tests: **576/576 passed, 41 files** ✅
- Server typecheck (source + test): ✅ clean after FakeMemory fix
- Client typecheck: ✅ clean
- Server build: ✅ clean
- Client build: ✅ clean (Next.js production build)
- Migration/application verification: **not done** against live DB.

### Outstanding limitations

- Migration `0013_agent_workflows.sql` not applied to live DB (unverified).
- Phase 6 (approval + secure execution) not yet implemented.
- Live provider/database verification blocked by environment (M5/M6 constraints).

---

## Phase 6 — Human approval and secure tool execution (2026-11-13)

**Deliverable:** approval lifecycle + immutable action binding + fail-closed
execution gate in `executeStep()` + authenticated `/api/approvals` API + 16
mandated security scenarios.

### Files changed (exact)

**New — approvals module (`server/src/agents/approvals/`):**

- `canonical.ts` — deterministic canonical serialization (recursive key sort,
  `-0` normalization, loud rejection of non-finite/unsupported values) and
  SHA-256 payload hash binding `user_id · run_id · step_id · capability ·
  operation · normalized args`. Recomputed at execution time from the
  **persisted step state**, never from model output or request bodies.
- `approval.store.ts` — owner-scoped row access (every statement carries
  `.eq('user_id', userId)`), compare-and-swap transitions for all 8 statuses,
  `expireStaleApprovals` (lazy sweep that also writes `approval.expired` audit
  events — only CAS conflicts swallowed, audit failures loud), append-only
  `insertAuditEvent` (no update/delete helper by construction).
- `approval.service.ts` — `requestApproval` (idempotent per exact action;
  stale-hash approvals expired and re-bound), `approveApproval` /
  `rejectApproval` / `cancelApproval` (authenticated decisions),
  `consumeApprovalForExecution` (the **nine-check fail-closed gate**: owner,
  run, step, registered+available capability, operation allowlist, payload
  hash, expiry, persisted-args equality, then atomic APPROVED → EXECUTING CAS),
  `completeApproval` (EXECUTING → EXECUTED / FAILED on every exit path),
  `evaluateStepApproval` (`none | pending | approved | denied | spent`),
  `findApprovedApprovalForStep` for resume.
- `policy.ts` — explicit risk matrix over all 12 registered capabilities
  (`read` → no approval; `mutating` → approval by default policy;
  `destructive` → approval always; `unsupported` → dispatch refused).
  Asserted identical to the registry's `approvalRequired` flags by tests.
- `approval.schemas.ts` — Zod: UUID id param, list filters, and a
  **strictly-empty** decision body (`.strict()`) so a body-borne `user_id`
  is a 400, never an identity source.
- `index.ts` — module barrel.

**New — API:**

- `server/src/controllers/approval.controller.ts` — handlers with explicit
  `AgentError → HTTP` mapping (400/403/404/409/410/503/500) mirroring the
  central handler's 5xx message sanitization; owner-scoped 404 that is
  indistinguishable from a missing id; every decision triggers `resumeRun`
  (failure → `resumed: false`, decision still stands) and re-fetches the
  post-resume approval row for the response.
- `server/src/routes/approval.routes.ts` — router-level `requireAuth`.
- `server/src/app.ts` — mounted `app.use('/api/approvals', approvalRoutes)`.

**Modified — orchestrator (`server/src/agents/orchestrator/orchestrator.service.ts`):**

- `StepExecContext.currentStatus` — the CAS `from` for every step transition.
- `executeStep()` approval gate (before any side effect): persisted
  `evaluateStepApproval` decides — `denied` → step `cancelled` without
  executing; `spent` → step `failed` (persisted from `ctx.currentStatus` so
  the dispatcher's `running→failed` CAS cannot miss it); `none|pending` →
  durable idempotent PENDING request + step `waiting_approval` + run pause
  (request failure settles the step honestly instead of pausing with an
  undecidable row); `approved` → `consumeApprovalForExecution` CAS first
  (APPROVED → EXECUTING), then execute, then `completeApproval` on **every**
  exit path: ok → `executed`; failure/cancel → `failed`; runtime
  `needs_approval` → settle consumed grant `failed` and request a fresh
  durable PENDING before pausing.
- Seed loop: `waiting_approval` steps are promoted only by a valid APPROVED
  grant bound to exactly this step/run; `denied` → `cancelled`, `spent` →
  `failed`, `none|pending` → stay paused (run keeps `awaitingApproval`).

**Tests (new):**

- `server/tests/agent-approvals.test.ts` — **27 tests**: S1–S9, S11–S16,
  cancellation settling, failure settling (consumed grant settles `failed`),
  canonical binding (3), risk-matrix agreement (1), orchestrator extras
  (dependents untouched by a pause, resume-never-reruns-completed,
  read-only zero-approval, audit append-only/owner-scoped), lifecycle CAS
  (2).
- `server/tests/approval-api.test.ts` — **15 tests**: 401×5 endpoints,
  list/detail scoping + filters, S9 over HTTP (404 non-leaking), S10 forged
  identity (body `user_id` → 400; header ignored; token decides), S1
  approve→execute E2E over HTTP, S2 reject settles, S11 replay 409,
  flip-after-reject 409, 410 expiry + sweep audit, cancel + repeat 409,
  malformed id 400, orchestrated pause → HTTP approve → resume E2E.

**Test double:** `server/tests/helpers/fakeSupabase.ts` — added
`agent_audit_events` table + getter, `.gt()` filter support, cascade to
audit rows, `executed_at` on approvals.

**Migration:** `supabase/migrations/0013_agent_workflows.sql` extended in
place (never a new file, **never applied to any DB**): 8-status CHECK,
`executed_at`, partial unique `agent_approvals_step_pending_unique`
(`WHERE status = 'pending'`), `payload_hash ~ '^[0-9a-f]{64}$'` CHECK,
append-only `agent_audit_events` (SELECT + INSERT policies only, no
UPDATE/DELETE policy), `agent_approvals_enforce_owner` trigger, owner-scoped
approval UPDATE policy, RLS enabled on all 4 tables.

### The 16 mandated security scenarios (all covered, all green)

| # | Scenario | Where |
|---|---|---|
| S1 | Valid approval → execution of the exact action, exactly once | both files (service + HTTP E2E) |
| S2 | Rejected approval never executes; step/run settle `cancelled` | both files |
| S3 | Expired approval cannot execute; sweep audited; step/run settle | agent-approvals (+410 in API) |
| S4 | Modified payload fails the binding check → step `failed`, no side effect | agent-approvals |
| S5 | Different capability refused even with recomputed hash (registry gate) | agent-approvals |
| S6 | Different operation refused at the consumption gate | agent-approvals |
| S7 | Approval cannot be moved to a different workflow | agent-approvals |
| S8 | Approval bound to one step cannot drive another step | agent-approvals |
| S9 | Cross-user: cannot see, decide, or consume (404 non-leaking over HTTP) | both files |
| S10 | Forged identity: body `user_id` → 400, header ignored, no token → 401 | approval-api |
| S11 | Replay of spent grant / decided request refused (409) | both files |
| S12 | Concurrent consumption: exactly one wins the CAS | agent-approvals |
| S13 | Executed approval cannot produce a duplicate side effect | agent-approvals |
| S14 | Unregistered capability cannot consume an approval | agent-approvals |
| S15 | Args changed after approval refused at consumption | agent-approvals |
| S16 | Prompt injection cannot disable the gate or self-approve | agent-approvals |

Plus: pause leaves dependents untouched; resume executes exactly the
approved step; rejection/expiry/cancellation/failure all settle honestly;
audit chain `requested→approved→consumed→executed` verified; read-only
capabilities create zero approvals/audit events.

### Security guarantees (implemented + tested)

- No side effect occurs before the nine-check consume gate passes and the
  atomic APPROVED → EXECUTING CAS wins.
- Model-supplied output (plan args, `requiresApproval` flags, objectives)
  can only *request* a PENDING approval — never decide it.
- Identity comes exclusively from the verified bearer token; decision
  bodies are strictly empty; all queries/transitions owner-scoped.
- Approvals are single-use (partial unique pending index + CAS + audit
  trail); execution re-hashes persisted state byte-for-byte.
- Append-only audit events (select/insert-only RLS policies; no update or
  delete helper exists in the store).

### Validation — six gates (all green, re-verified at Phase 6 close)

1. Server tests: **618/618 passed, 43 files** ✅ (576 baseline preserved,
   42 new; zero tests weakened)
2. Server typecheck (source + test tsconfigs): ✅ clean
3. Server build (`tsc -p tsconfig.json`): ✅ clean
4. Client typecheck: ✅ clean
5. Client build (Next.js production): ✅ clean
6. Migration/RLS inspection gate: ✅ **PASS, 12/12 mechanical checks**
   (sequential 0001–0013 numbering; 8-status CHECK; partial unique pending
   index; sha256 hash CHECK; audit table; audit SELECT/INSERT policies with
   NO update/delete policy; owner trigger; `executed_at`; RLS on all 4
   tables; owner-scoped approval UPDATE policy). **Inspection only — 0013
   was NOT applied to any database.**

### Outstanding limitations

- Migration `0013` (incl. all Phase 6 extensions) **not applied to a live
  DB** — no local Supabase/Docker stack; RLS policies, the owner trigger and
  the partial unique index are verified by SQL inspection only, **not live
  verified**.
- Approval E2E runs against the in-memory fake Supabase (service-layer
  ownership filters and CAS verified; the fake does not emulate RLS/FKs).
- No live LLM/provider calls (OpenAI mocked; no API charges).
- Live provider/database verification blocked by environment
  (`SUPABASE_SERVICE_ROLE_KEY`, `EVAL_USER_ID`, `EVAL_CONFIRM`, Docker,
  Ollama all missing).
- All M5 + M6 work remains uncommitted by design — **no commits or pushes
  made**.

---
