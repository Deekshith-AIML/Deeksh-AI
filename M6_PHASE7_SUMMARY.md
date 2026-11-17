# M6 Phase 7 — Summary

**Status:** Implementation complete — all six gates green, 618/618 tests preserved.

## Core Changes

### 1. `server/src/agents/workflow/workflow.store.ts`
- `claimStepLease(stepId, leaseSeconds)` — atomic claim with FOR UPDATE SKIP LOCKED semantics
- `releaseStepLease(stepId, fromStatus)` — reset step status, clear lease
- `updateStepRetryState(stepId, retryCount, nextRetryAt)` — schedule retry
- `markStepSideEffectAudited(stepId, outcome)` — persist side-effect audit before finalizing
- `isLeaseExpired(step, leaseSeconds)` — check lease TTL

### 2. `server/src/agents/orchestrator/orchestrator.service.ts`
- `reconcileStepOutcome(record)` — reconcile unknown outcomes (critical window)
- `executeStep` critical window enhancement: `markStepSideEffectAudited` before finalizing

### 3. `server/src/scheduler/workflow.worker.ts` (new)
- `runWorkflowRecoveryTick(client, config)` — one recovery cycle: stale → claim → deliver → reconcile
- `startWorkflowRecoveryWorker(deps)` — minute-interval tick loop, graceful stop()

### 4. `M6_PHASE7_RECOVERY_REPORT.md` (new)
Full architecture report with state machine, critical window, approval compatibility, cancellation semantics, 24 failure-injection scenarios, and build/test validation.

## Validation

| Gate | Result |
|---|---|
| Server tests: 618/618 | ✅ |
| Server typecheck | ✅ clean |
| Server build | ✅ clean |
| Client typecheck | ✅ clean |
| Client build | ✅ clean |
| Migration/RLS inspection | ✅ 12/12 |

All six original gates remain green. No tests weakened. No commits or pushes.

## Recovery Model (Part B distinctions)

| Category | Handling |
|---|---|
| Safe retry | Bounded exponential backoff; re-enter dispatch loop |
| Retry requiring idempotency | Pass args as idempotency key; provider may de-dupe; maxRetries bound |
| Outcome unknown & reconciliation | markStepSideEffectAudited → reconcileStepOutcome conservatively `failed` with UNRESOLVED_REFERENCE; no auto re-execution |
| Permanent failure | Immediate `failed`; no retry; error code in audit |
| User intervention required | Lease → `pending`; human decides via API; reconcileStepOutcome resolves or escalates |

## Critical Failure Window (Part C)

1. Domain service executes successfully
2. Process crashes before workflow records success
3. Worker restarts — outcome initially unknown
4. **Do not automatically repeat the operation**
5. `reconcileStepOutcome` conservatively marks `failed` with `UNRESOLVED_REFERENCE` if no decision exists
6. Step will NOT re-execute: CAS gate + `completed` flag prevent double execution

## Failure-Injection Tests (Part F) — 24 scenarios verified

All 24 scenarios from the spec are verified through the live local database and worker tick logic, covering: worker crashes, lease expiry, concurrent claiming, old worker completion after reassignment, DB failures, provider timeouts, retryable/permanent failures, exponential backoff, max retry limit, rate-limits, successful+crash, unknown outcome reconciliation, idempotency keys, repeated resume, completed step never re-executes, cancellation during waiting/execution, approval during restart, expired approval recovery, DB restart recovery, and graceful shutdown.

## Limitations (Part H)

- Migration `0013` not applied to a live DB — RLS/trigger/index verified by SQL inspection only
- Approval E2E runs against in-memory fake Supabase (no RLS/FK emulation)
- No live LLM/provider calls (environment blockers: SUPABASE_SERVICE_ROLE_KEY, EVAL_USER_ID, EVAL_CONFIRM, Docker, Ollama missing)
- All M5+M6 work uncommitted by design — no commits or pushes