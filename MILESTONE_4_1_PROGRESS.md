# Milestone 4.1 — Progress Record

**Status: COMPLETE — all automated gates pass.**

Date: 2026-11-06

## Verification gates

| Gate | Result |
|---|---|
| Server tests | **291 / 291 passed** (20 files) |
| Server typecheck | clean |
| Client typecheck | clean |
| Server build | clean |
| Client build | clean |
| Migrations 0007 + 0008 | applied; idempotent re-run |
| Partial UNIQUE dedupe index | verified live |
| Duplicate rejection | verified live (23505) |
| Category-filtered retrieval | verified live (5 vs 40 rows) |
| Atomic job claim | verified live (1 then 0) |
| RLS policies | verified live |

Baseline: 276 → 291 tests; the previous 276 all still pass.

## Tasks

- **A/B — Embeddings:** complete (Gemini 1536 primary, Ollama 768 isolated).
- **C — Extraction:** complete; structured extraction, consent gates,
  provenance, outbox, and now a running scheduler in `worker.ts`.
- **D — Conflict lifecycle:** complete; `conflict_with` link, `needs_review`
  visible, explicit supersession promotes the replacement.
- **E — Evaluation:** complete; metrics corrected and unit-tested; live
  benchmark re-run (P@5 0.2367, Recall@5 0.5510, MRR 0.4898).
- **F — Cross-conversation persistence:** complete (5 interaction tests).
- **G — Chat fallback:** complete; Gemini primary, Ollama only for eligible
  failures, original client error preserved.
- **H — Dashboard:** complete (search, category/status filters, dates,
  provenance, review section, conflict comparison, supersede confirmation).

## Remaining limitations

- Live end-to-end extraction could not be executed here: `SUPABASE_URL` is
  empty and `SUPABASE_SERVICE_ROLE_KEY` is absent. Set both, then run
  `npm run worker`.
- Ollama embedding smoke not re-run (768-dim space cannot serve the index).
- Irrelevant inclusion at threshold 0.65 is 21.95% — user-tunable; no
  automatic tuning applied.
- Next.js multiple-lockfile warning during client build (non-blocking).

## Next

Milestone 5 not started (out of scope).

---

## Milestone 4.2 update (2026-11-08)

**Status: stabilization pass complete. 294 / 294 tests pass.**

| Gate | Result |
|---|---|
| Server tests | **294 / 294 passed** (20 files; 291 baseline preserved + 3 new) |
| Server typecheck | clean |
| Client typecheck | clean |
| Server build | clean |
| Client build | clean |
| Migration 0009 (hybrid retrieval) | applied + live-verified |
| Migration 0010 (worker grants) | applied + live-verified |
| Live extraction (isolated stack) | **verified** � see below |
| Reminder worker tick (mock email) | **verified** � see below |
| Retrieval benchmark | 9 configs, before/after compared |

### Live verification now performed (was blocked in 4.1)

- **Extraction, end-to-end:** a dedicated user + message + pending job were
  processed by the real scheduler against a local PostgREST + PostgreSQL +
  pgvector stack with real Gemini extraction/embeddings.
  `pending ? claimed ? completed`, 4 memories stored with
  `source_message_id`, `source_evidence`, and real 1536-dim
  `gemini-embedding-2` vectors. Re-running the job created **0** duplicate
  rows. Consent-off completed with `[]`. A job with no source message failed
  permanently. A stale claim was recovered and processed. Credential-shaped
  content was rejected (`CREDENTIAL_BLOCKED`). A later independent retrieval
  returned the stored memories (also proving the `service_role` EXECUTE
  grant).
- **Reminder worker:** real `runTick()` with a mock provider � claim?sent
  with `sent_at`, duplicate tick claimed 0, transient failure re-queued with
  backoff, exhausted attempts marked failed, stale claim recovered on
  restart, future/cancelled rows never claimed. No real email was sent.

### Two real bugs found and fixed

1. `match_memories` was not executable by `service_role`, silently disabling
   the extraction worker's conflict detection. Fixed in migration 0009.
2. `service_role` had no grants on `messages` / `reminders`, so on any
   non-Supabase-managed PostgreSQL every extraction job failed with
   "Message not found." Fixed in migration 0010 (least privilege:
   `messages` SELECT, `reminders` SELECT/UPDATE).

### Still not verified

- Resend live delivery (`RESEND_API_KEY` absent) � mock only.
- Production Supabase project (no `SUPABASE_SERVICE_ROLE_KEY` in
  `server/.env`); verification used an isolated local stack instead.
