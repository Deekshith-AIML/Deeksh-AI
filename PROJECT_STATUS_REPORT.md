# DEEKSH AI — Project Status Report

**Milestone:** 5 — Personal Knowledge Base & RAG (Phase 12 evaluation)
**Date:** 2026-11-10 (M5) / 2026-11-13 (M6 Phase 6 update)
**Status:** Milestone 5 implemented through Phase 12. Deterministic evaluation
and all six gates green. Live document RAG verification **blocked** by missing
Supabase service-role configuration.

**Milestone 6 update (2026-11-13):** Phases 0–6 of the Multi-Agent
Orchestration Engine are complete — including Phase 6 (human approval +
secure execution: approval lifecycle, immutable payload binding, fail-closed
execution gate, authenticated `/api/approvals` API, all 16 mandated security
scenarios). Server suite: **618/618 passed, 43 files**; all six gates green.
Migration `0013_agent_workflows.sql` remains **unapplied to any live DB**
(SQL inspection only). Phase 7 not started. See `MILESTONE_6_REPORT.md`.

This report is evidence-based. Every claim below is labelled:

- **Implemented** — code exists.
- **Unit/integration tested** — covered by the automated suite.
- **Live verified** — executed against a real PostgreSQL/pgvector stack in this
  milestone.
- **Blocked** — requires configuration that was not available.

---

## 1. Architecture

```
┌────────────────────┐      HTTPS/JSON      ┌──────────────────────┐
│  Next.js client    │ ───────────────────► │  Express API server  │
│  (React, TS)       │                      │  (Node 22, TS)       │
└─────────┬──────────┘                      └──────────┬───────────┘
          │ Supabase Auth (JWT)                        │ user-scoped client
          │                                            │ (anon key + user JWT)
          ▼                                            ▼
┌──────────────────────────────────────────────────────────────────┐
│ Supabase / PostgreSQL 16 + pgvector 0.8.7                        │
│  auth.users, public.users, tasks, messages, reminders,           │
│  memories, memory_settings, memory_extraction_jobs,              │
│  integration_grants, memory_dedupe_audit                         │
│  Row Level Security on every user table                          │
└──────────────────────────────▲───────────────────────────────────┘
                               │ service-role client
                    ┌──────────┴────────────┐
                    │ Background worker      │
                    │ (separate process)     │
                    │ reminders + extraction │
                    └───────────────────────┘
```

Three deployable units: **client**, **API server**, **worker**. The worker is
a separate process so scheduling survives API restarts and can scale
independently.

---

## 2. Implemented modules

| Module | State |
|---|---|
| Google + email authentication, session handling | Implemented, tested |
| Multi-user isolation (RLS + service-level ownership filters) | Implemented, tested, live verified |
| Task management with date/timezone handling | Implemented, tested |
| Scheduled reminders (atomic claim, retries, cancel/reschedule) | Implemented, tested, live verified |
| Chat with Gemini primary + Ollama fallback | Implemented, tested |
| Tool calling (create/update/list tasks and reminders) | Implemented, tested |
| Memory storage, categories, provenance, conflict lifecycle | Implemented, tested, live verified |
| Memory extraction worker (durable outbox) | Implemented, tested, **live verified** |
| Embeddings (Gemini 1536 primary, Ollama 768 isolated) | Implemented, tested, live verified (Gemini) |
| Hybrid memory retrieval (vector + full-text) | Implemented, tested, live verified |
| Memory dashboard (search, filters, review, supersede) | Implemented |
| Integration grants (Google login kept separate) | Implemented, tested |
| Document upload, extraction, chunking and durable processing (PDF/DOCX/TXT) | Implemented, tested |
| Document retrieval (pgvector), citations and RAG answers | Implemented, tested (mocked answers); live E2E blocked |
| Knowledge Base UI (list, search, citation viewer) | Implemented, build-verified |

Explicitly **not** implemented (scope control): OCR, malware scanning,
multi-agent orchestration, Gmail API, Google Calendar API, WhatsApp, YouTube.

---

## 3. Completed milestones

| Milestone | Scope | Status |
|---|---|---|
| M1 | Date handling + task management | Complete |
| M2 | Scheduled reminders | Complete |
| M3 | Google authentication + multi-user security | Complete |
| M4 | Hybrid memory infrastructure | Complete |
| M4.1 | Memory intelligence + retrieval evaluation | Complete |
| M4.2 | Stabilization + production readiness | Complete |
| M5 | Personal Knowledge Base + RAG (Phases 1–11) | Complete |
| M5 Phase 12 | Document RAG evaluation | Deterministic evaluation complete; live E2E blocked |

---

## 4. Verified technologies

| Component | Version / detail | Verification |
|---|---|---|
| Node.js | v22.16.0 | runtime |
| npm | 10.9.2 | runtime |
| TypeScript | strict, server + client | typecheck (see §11) |
| Express | 4.21 | tests |
| Next.js | 15.5.28 | production build |
| React | via Next.js | build |
| PostgreSQL | 16.15 (Docker `chitti-pg`, port 55432) | live |
| pgvector | 0.8.7 | live |
| PostgREST | 12.2.0 (verification harness only) | live |
| Supabase JS | 2.45.x | tests |
| Gemini | chat + `gemini-embedding-2` (1536 dims) | live API |
| Ollama | `embeddinggemma` (768 dims, isolated) | previously verified |

---

## 5. Database architecture

**Migrations (`supabase/migrations`):**

| File | Purpose | State |
|---|---|---|
| `0001_init.sql` | users, tasks, messages, triggers | applied |
| `0002_auth_hardening.sql` | auth linkage, profile sync | applied |
| `0003_scheduled_reminders.sql` | reminders, claim/recover functions | applied |
| `0004_google_auth.sql` | Google identity, integration grants | applied |
| `0005_memory_engine.sql` | memories, settings, jobs, `match_memories` | applied |
| `0006_memory_extraction_index_constraints.sql` | index constraints | applied |
| `0007_memory_dedupe_unique_index.sql` | partial UNIQUE dedupe | applied |
| `0008_match_memories_category_and_conflict_link.sql` | category filter + conflict link | applied |
| `0009_match_memories_hybrid_lexical.sql` | hybrid retrieval + FTS index + grants | **applied 2026-11-08** |
| `0010_service_role_worker_grants.sql` | least-privilege worker grants | **applied 2026-11-08** |
| `0011_documents_schema.sql` | documents, chunks (`vector(1536)` + HNSW), jobs, RLS, `match_document_chunks`, worker functions | requires live DB for verification |
| `0012_documents_storage.sql` | private `documents` bucket + storage policies (guarded) | requires live DB/Storage for verification |

There is **no** `supabase_migrations.schema_migrations` table locally;
migration state was determined by inspecting the actual schema, then only the
genuinely missing migrations were applied. No migration was blindly re-run, no
database was dropped, no user table was truncated. Migrations 0011–0012 have
not been exercised against a live Supabase project in this phase.

**Tables:** 9 in `public` for M1–M4.2 (`users`, `tasks`, `messages`,
`reminders`, `memories`, `memory_settings`, `memory_extraction_jobs`,
`integration_grants`, `memory_dedupe_audit`), plus M5's `documents`,
`document_chunks` and `document_processing_jobs` once migration 0011 is
applied.

**Memory indexes:**

- `idx_memories_embedding_cosine` — HNSW cosine index on `embedding`.
- `memories_user_content_unique_idx` — partial UNIQUE `(user_id, content)`
  for active rows (duplicate prevention).
- `idx_memories_content_fts` — GIN full-text index (new in 0009).
- `idx_memories_user_category_active`, `idx_memories_conflict_with`,
  `idx_memories_source_message` — supporting indexes.

**Document indexes:** HNSW cosine index on `document_chunks.embedding`, plus
user/document/chunk-index and pending-job indexes (migration 0011).

**RLS:** policies exist on all user tables. Every table has
`auth.uid() = user_id` SELECT/INSERT/UPDATE/DELETE policies; document tables
add the same ownership model and storage policies are scoped per user folder.

**Local data note:** the local DB contains 6 fixture users, 2 tasks, 15
legacy reminder fixtures, and 40 synthetic benchmark memories. **These are
fixtures, not real user data.**

---

## 6. LLM provider architecture

- **Chat primary:** Gemini via the OpenAI-compatible endpoint
  (`GEMINI_API_KEY`, `GEMINI_MODEL`, optional `GEMINI_BASE_URL`).
- **Chat fallback:** Ollama Mistral, used only for eligible failures
  (connection/timeout/5xx). The original Gemini error is preserved for
  diagnostics.
- **Embeddings:** `EMBEDDING_PROVIDER=gemini|ollama`. The production index is
  `vector(1536)` and served only by `gemini-embedding-2`. Ollama
  `embeddinggemma` is 768-dim and is **isolated evaluation only** — vectors
  are never padded, truncated, or mixed across spaces.
- **Cost/latency control:** retrieval makes exactly one embedding call; no
  LLM reranker was added to the retrieval path.

---

## 7. Memory architecture

1. **Capture:** a user message may enqueue a durable job in
   `memory_extraction_jobs` when automatic extraction consent is ON.
2. **Processing:** the worker atomically claims jobs
   (`FOR UPDATE SKIP LOCKED`), re-checks consent, ignores assistant turns,
   runs Zod-validated structured extraction, drops credential/low-confidence
   items, and stores memories with provenance
   (`source_message_id`, `source_evidence`).
3. **Statuses:** high confidence → `active`; medium → `needs_review`;
   supersession/expiry tracked explicitly. Conflicts link via `conflict_with`
   and require user confirmation — no automatic 0.92 supersession.
4. **Retrieval:** `match_memories(query_embedding, user_id, threshold, count,
   category, query_text)`:
   - vector candidates must meet `match_threshold`;
   - when `query_text` is supplied, full-text (`plainto_tsquery`) matches are
     included even below the threshold and rank first;
   - `similarity` remains raw cosine similarity;
   - results are always scoped to the verified user, `status='active'`,
     non-superseded, non-expired, and non-credential.
5. **Chat injection:** memory is injected into the **user turn** as delimited
   untrusted reference data, never into the system prompt, and can never
   authorize a tool call.

---

## 8. Reminder architecture

- State lives entirely in PostgreSQL (`reminder_at`, `next_attempt_at`,
  `attempts`, `max_attempts`, `claimed_at`, status).
- Each tick: `recover_stale_reminders()` → `claim_due_reminders()`
  (`FOR UPDATE SKIP LOCKED`) → send → persist the true outcome.
- Delivery is marked `sent` only after the provider confirms acceptance.
- Transient failures re-queue with bounded exponential backoff; exhausted or
  permanent failures become `failed` with a reason.
- Status updates are guarded by `.eq('status','claimed')` to prevent
  double-writing a row re-claimed elsewhere.
- Provider factory: Resend when configured, otherwise a mock that sends
  nothing. `NODE_ENV=test` always forces the mock.

---

## 9. Authentication and security

Verified in this milestone:

- **No secret values in source or builds.** Scanned changed files and build
  artifacts; only variable *names* appear in server output, and only
  placeholder/fake keys in tests.
- **`.env` files are gitignored** and no `.env` is tracked
  (`git ls-files` check).
- **Ownership:** API identity comes only from a verified JWT. Client-supplied
  `x-user-id`, `?user_id=` and body `user_id` are ignored. RLS is the second
  layer.
- **Google login is separate from Gmail/Calendar.** Integrations require an
  explicit per-integration grant; authentication alone grants no data access.
- **Memory cannot authorize tools.** The system prompt states memories are
  untrusted reference data and cannot authorize actions; covered by tests.
- **Credential-like text is rejected** before storage
  (`CREDENTIAL_BLOCKED`) — unit-tested and live-verified.
- **Error handling:** 5xx responses return a generic message; internals are
  logged server-side only.
- **CORS:** explicit origin allow-list; `*` must be opted into and
  `x-user-id` is not an allowed header.
- **Worker permissions:** the worker uses the service-role key in a process
  that serves no HTTP traffic. Migration 0010 gives that role the minimum
  privileges it needs.

**Findings fixed:** `service_role` had no EXECUTE on `match_memories` (worker
conflict detection silently disabled) and no grants on `messages`/`reminders`
(worker could not run on plain PostgreSQL). Both fixed by migrations 0009 and
0010.

---

## 10. API inventory

All routes except `/health` require `Authorization: Bearer <Supabase JWT>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness (no user data) |
| POST | `/api/chat` | chat turn (tools, memory context) |
| GET | `/api/tasks` | list tasks |
| GET | `/api/tasks/:id` | get task |
| POST | `/api/tasks` | create task |
| PUT | `/api/tasks/:id` | update task |
| DELETE | `/api/tasks/:id` | delete task |
| GET | `/api/reminders` | list reminders |
| GET | `/api/reminders/:id` | get reminder |
| POST | `/api/reminders` | create reminder |
| PUT | `/api/reminders/:id` | update/reschedule |
| DELETE | `/api/reminders/:id` | cancel reminder |
| GET | `/api/me` | profile |
| PATCH | `/api/me` | update profile |
| GET | `/api/integrations` | list grants |
| POST | `/api/integrations` | grant integration |
| DELETE | `/api/integrations/:integration` | revoke |
| GET | `/api/memories/settings` | memory settings |
| PATCH | `/api/memories/settings` | update settings |
| GET | `/api/memories` | list memories |
| POST | `/api/memories` | create memory |
| POST | `/api/memories/search` | vector (+ optional `query_text`) search |
| GET | `/api/memories/:id` | get memory |
| PATCH | `/api/memories/:id` | correct memory |
| DELETE | `/api/memories/:id` | delete memory |
| POST | `/api/memories/:id/supersede` | confirm supersession |
| POST | `/api/documents` | upload PDF/DOCX/TXT (25 MiB) |
| GET | `/api/documents` | list/filter documents |
| GET | `/api/documents/:id` | details + processing job |
| PATCH | `/api/documents/:id` | rename |
| DELETE | `/api/documents/:id` | delete (chunks, jobs, object) |
| POST | `/api/documents/:id/retry` | retry a failed document |
| GET | `/api/documents/:id/view` | short-lived signed view link |
| GET | `/api/documents/:id/content` | authenticated local content |
| GET | `/api/documents/:id/chunks` | chunk preview with provenance |
| POST | `/api/documents/search` | semantic search over ready documents |

---

## 11. Test results

Commands (PowerShell-compatible):

```powershell
npm test --prefix server                         # 459 / 459 passed, 36 files
npm run typecheck --prefix server                # source + test configs: clean
server\node_modules\.bin\tsc.cmd --noEmit -p server/tsconfig.test.json  # clean
npm run typecheck --prefix client                # clean
npm run build:server                             # clean
npm run build:client                             # Next.js production build: success
```

| Gate | Result |
|---|---|
| Server tests | **459 passed / 459** (433 pre-existing preserved + 26 Phase 12 tests) |
| Test files | 36 / 36 |
| Server typecheck (source + tests) | clean |
| Client typecheck | clean |
| Server build | clean |
| Client build | 6 routes generated, no errors |
| Secret scan of builds | no key values; only env-var names server-side |

Coverage spans authentication, tasks, reminders (including worker), memory
API, extraction worker/scheduler, embeddings, chat isolation and fallback,
OAuth callbacks/security, profile, integrations, document upload/extraction/
chunking/worker/deletion/search/citation navigation, metric regression tests,
and the Phase 12 document-RAG dataset, metrics, answer-path isolation and edge
cases.

---

## 12. Benchmark comparison

Same dataset (40 seeded memories, 51 queries), same embeddings, one seeding
pass, measured against the real migrated SQL function.

| Metric | Vector (pre-4.2) | Hybrid (4.2) | Change |
|---|---|---|---|
| Precision@5 | 0.2367 | **0.3265** | +0.0898 (+37.9%) |
| Recall@5 | 0.5510 | **1.0000** | +0.4490 |
| MRR | 0.4898 | **1.0000** | +0.5102 |
| Relevant retrieval rate | 0.5510 | **1.0000** | +0.4490 |
| Irrelevant inclusion rate | 0.2195 | 0.2195 | unchanged |
| Empty-query rejection | 1.00 | 1.00 | unchanged |
| Avg DB RPC latency | ~51–54 ms | ~57–59 ms | +~6 ms (+~11%) |

Threshold sweep (0.60/0.65/0.70/0.72/0.75) produced identical vector results
on this dataset, so the default remains **0.65**. The gain comes from exact
lexical matches (40 exact-token queries); semantic-query quality was already
1.0 and is unchanged. Irrelevant inclusion is unaffected. Because the
improvement is consistent and non-regressing, hybrid is kept, but it is only
activated when a query string is supplied — omitting `query_text` preserves
the old behaviour exactly.

### Document RAG — evaluation status (Phase 12)

| Area | Result |
|---|---|
| Dataset | 20 documents (7 PDF, 6 DOCX, 7 TXT), deterministic |
| Queries | 72 (58 scored, 14 safety) across 10 categories |
| Ground truth | Hand-authored anchors resolved through real extraction + chunking |
| Metric implementations | P@5, R@5, MRR, relevant/irrelevant rates, latency p50/p95, citation/refusal rates — unit tested |
| Live retrieval / citation / faithfulness scores | **Not computed — live run blocked** |
| Gemini primary / Ollama fallback | Mocked equivalence verified; live quality not measured |
| Edge cases | Scanned PDF, empty text, oversized TXT, zero chunks, deletion, worker retry/idempotency verified |

The live script (`npm run eval:documents --prefix server`) is opt-in and
requires `SUPABASE_SERVICE_ROLE_KEY`, `EVAL_USER_ID` and `EVAL_CONFIRM=yes`.
Without them it writes an explicit blocked report and produces no scores.
See `DOCUMENT_RAG_EVALUATION_REPORT.md`.

---

## 13. Operational verification

### Memory extraction — **LIVE VERIFIED** (isolated stack)

Environment: local PostgreSQL 16 + pgvector 0.8.7 + PostgREST 12.2.0 behind a
`/rest/v1` shim, real Gemini extraction and embeddings, dedicated synthetic
user. The production Supabase project was not touched.

| Scenario | Observed |
|---|---|
| Normal extraction | `pending → claimed → completed`, 4 memories, real 1536-dim vectors, provenance present |
| Duplicate prevention | re-run created **0** duplicate rows, returned the same ids |
| Consent OFF at processing | completed with `[]`, message never sent to the LLM |
| Permanent failure (no message) | `failed` with "No source message." |
| Stale claim recovery | orphaned claim recovered and processed |
| Credential-like text | rejected (`CREDENTIAL_BLOCKED`) |
| Subsequent retrieval | returned the stored memories (also proves `service_role` EXECUTE) |

### Reminder worker — **LIVE VERIFIED** (mock delivery)

| Scenario | Observed |
|---|---|
| Claim + send | `sent`, `sent_at` set, mock provider called with the user's email |
| Duplicate tick | claimed 0, `sent_at` unchanged |
| Transient failure | back to `pending`, `attempts=1`, future `next_attempt_at` |
| Attempts exhausted | `failed` with reason |
| Stale claim on restart | recovered and delivered |
| Future reminder | not claimed |
| Cancelled reminder | not claimed |

No real email was sent. Existing fixture reminders were temporarily deferred
and restored exactly; fixture rows were deleted afterwards.

### Database — **LIVE VERIFIED** (rolled-back transaction)

`supabase/local-dev/verify_0007_0008.sql`: 11/11 checks PASS — category
filtering, user isolation, duplicate `23505`, superseded-duplicate exemption,
RLS visibility, extraction atomic claim (1→0), extraction stale recovery,
reminder atomic claim, stale recovery, future exclusion, cancellation.

---

## 14. Known limitations

1. **Resend live delivery — blocked.** `RESEND_API_KEY` / `RESEND_FROM_EMAIL`
   are not configured, so only the mock provider was exercised. Delivery
   status logic is verified; actual email delivery is not.
2. **Production Supabase project — blocked.**
   `SUPABASE_SERVICE_ROLE_KEY` is absent from `server/.env`, and `SUPABASE_URL`
   points at a remote project. Live verification therefore ran on an isolated
   local stack. The application code path is identical; the remote project
   itself was not exercised.
3. **Benchmark is synthetic.** Gains are dominated by exact-token matching.
   Real-user paraphrase retrieval is not measured.
4. **Irrelevant inclusion remains 21.95%.** Hybrid does not address it.
5. **No rate limiting / no `helmet`.** Body size is capped at 1 MB and CORS is
   allow-listed, but there is no per-IP/per-user request throttling. Recommended
   before public deployment.
6. **API server has no graceful-shutdown handler.** The worker handles
   SIGINT/SIGTERM; the API process does not drain in-flight requests. Low risk,
   recommended for container deployment.
7. **`npm audit` (server): 2 high-severity advisories** — Zod constrained-
   collection memory exhaustion and `openai` depending on the affected Zod.
   Fixing requires a Zod 4 major upgrade (breaking). Partially mitigated by the
   1 MB JSON body limit; schedule the upgrade deliberately.
8. **Ollama embedding evaluation** not re-run (768-dim vectors cannot serve
   the 1536-dim index).
9. **Next.js multiple-lockfile warning** during client build (non-blocking).
10. **Local DB contains fixtures**, including 15 legacy reminder rows and 40
    synthetic benchmark memories. They are not production data.
11. **Document RAG live verification — blocked.** `SUPABASE_SERVICE_ROLE_KEY`
    and `EVAL_USER_ID` are missing, and no local Docker/Supabase stack is
    available. No live P@5 / R@5 / MRR / citation / faithfulness score exists;
    only deterministic pipeline and metric tests were run.
12. **No OCR and no malware scanning.** Scanned PDFs fail with
    `SCANNED_PDF_REQUIRES_OCR`; password-protected/encrypted PDFs are
    unsupported (encrypted DOCX ZIP entries are rejected).
13. **Semantic citation support is not auto-judged.** A deterministic
    expected-phrase proxy plus exported reply/citation text is used for human
    review; no LLM-judge score is claimed.
14. **Signed-URL expiry is not simulated.** Only the issued 120s TTL and the
    absence of public URLs are asserted.

---

## 15. Environment variables

### Server (`server/.env`, gitignored; template in `server/.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | default 3001 |
| `NODE_ENV` | no | `development` / `production` / `test` |
| `CORS_ORIGIN` | production | comma-separated allow-list |
| `SUPABASE_URL` | yes | project URL |
| `SUPABASE_ANON_KEY` | yes | public/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | **worker only** | secret; never in client |
| `GEMINI_API_KEY` | yes | server-side only |
| `GEMINI_MODEL` | no | default `gemini-3.8-flash` |
| `GEMINI_BASE_URL` | no | override endpoint |
| `EMBEDDING_PROVIDER` | no | `gemini` (default) or `ollama` |
| `GEMINI_EMBEDDING_MODEL` | no | default `gemini-embedding-2` |
| `OLLAMA_BASE_URL` | ollama only | local evaluation |
| `OLLAMA_EMBEDDING_MODEL` | ollama only | `embeddinggemma` |
| `RESEND_API_KEY` | email only | secret |
| `RESEND_FROM_EMAIL` | email only | verified sender |
| `APP_BASE_URL` | no | links inside reminder emails |

### Client (`client/.env.local`, template in `client/.env.example`)

| Variable | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | public |
| `NEXT_PUBLIC_API_URL` | yes | backend base URL |

Never place `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, or
`RESEND_API_KEY` in a `NEXT_PUBLIC_*` variable.

---

## 16. Deployment requirements

1. Supabase project with migrations `0001`–`0012` applied in order.
   Migration `0013_agent_workflows.sql` (agent runs/steps/approvals +
   append-only audit, M6) is written and inspection-verified but **not yet
   applied anywhere** — apply it only to a local/staging stack first.
2. API server: Node ≥ 20, server env set, `npm run build` then
   `npm start`; expose `/health` for liveness.
3. Worker: same env **plus** `SUPABASE_SERVICE_ROLE_KEY`;
   `npm run start:worker` in exactly one supervised process (multiple
   replicas are safe thanks to `SKIP LOCKED`, but start with one).
4. Client: `npm run build:client` with `NEXT_PUBLIC_*` set at build time.
5. CORS: set `CORS_ORIGIN` to the deployed frontend origin.
6. Email: verify a Resend domain and set both Resend variables to leave mock
   mode.
7. Recommended before public exposure: add request rate limiting and
   `helmet`, and add graceful shutdown to the API process.
8. Do **not** deploy publicly as part of this milestone.

---

## 17. Git information

- Baseline commit preserved: `8c61e5b` ("Secure Coolie AI authentication and
  task API").
- Stabilization branch: `stabilization/m4.2`.
- Checkpoint commit: `ba180ae` — "feat: complete DEEKSH AI milestones
  M2-M4.1" (single reviewed checkpoint because the changes are
  interconnected). History was **not** rewritten.

---

## 18. Milestone status and next steps

### M5 — Personal Knowledge Base + RAG

Milestone 5 is implemented through Phase 12.
Deterministic evaluation, the full regression suite and all six gates are
green. Live document RAG verification remains blocked: the final audit on
2026-11-10 found `SUPABASE_SERVICE_ROLE_KEY`, `EVAL_USER_ID` and
`EVAL_CONFIRM` missing (no local Supabase/Docker stack; no Ollama
configuration).

**Decision: M5 is implementation-complete but not fully production-verified.
No live retrieval, citation or answer-quality score is claimed.**

### M6 — Multi-Agent Orchestration Engine (Phases 0–6)

Phases 0–6 are complete: shared interfaces, registry, workflow persistence,
orchestrator, domain agents, and human approval + secure execution.
Server suite **618/618 passed, 43 files** (all prior baselines preserved,
42 new Phase 6 tests covering the 16 mandated security scenarios); all six
gates green (server tests, server typecheck source+test, server build,
client typecheck, client build, migration/RLS inspection 12/12).

**Decision: Phase 6 is implemented and tested. It is NOT live-verified —
migration `0013_agent_workflows.sql` (extended with the approval lifecycle,
append-only audit table, owner trigger and RLS policies) has never been
applied to a database; RLS/trigger/partial-index behavior is verified by
SQL inspection only, and approval E2E tests run against the in-memory fake.
Phase 7 (recovery/error handling) has not been started. No commits or
pushes have been made; all M5 + M6 work remains uncommitted on
`stabilization/m4.2`.**

Next steps, in order:

1. Stand up a local/staging Supabase stack and apply migrations `0001`–`0013`
   there (never to production as part of a milestone), then live-verify
   Phase 6: RLS policies, the owner-consistency trigger, the partial unique
   pending index, and an approval E2E against the real database.
2. Continue M6 with Phase 7 (workflow recovery and error handling), keeping
   all 618 server tests green and re-running all six gates per phase.
3. Configure a dedicated synthetic test account (`EVAL_USER_ID`) and a
   development/staging `SUPABASE_SERVICE_ROLE_KEY`, then run
   `npm run eval:documents --prefix server` with `EVAL_CONFIRM=yes` to obtain
   the first real P@5 / R@5 / MRR / citation / latency results.
4. Only then evaluate whether any retrieval tuning is justified; do not tune
   against the synthetic benchmark alone.
5. Run the same live checks against the real Supabase project.
6. Verify Resend live delivery with an authorized test recipient.
7. Address remaining rate limiting / `helmet` / API graceful shutdown.
8. Plan the Zod 4 upgrade.
9. Build a paraphrase-based retrieval dataset before tuning thresholds.
