# DEEKSH AI — Project Status Report

**Milestone:** 4.2 — Stabilization & Production Readiness
**Date:** 2026-11-08
**Status:** Milestone 4.2 complete. Milestone 5 **not started** (out of scope).

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

Explicitly **not** implemented (scope control): PDF/DOCX upload, full RAG,
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
| M4.2 | Stabilization + production readiness | **This report** |

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

There is **no** `supabase_migrations.schema_migrations` table locally;
migration state was determined by inspecting the actual schema, then only the
genuinely missing migrations (0009, 0010) were applied. No migration was
blindly re-run, no database was dropped, no user table was truncated.

**Tables:** 9 in `public` (`users`, `tasks`, `messages`, `reminders`,
`memories`, `memory_settings`, `memory_extraction_jobs`, `integration_grants`,
`memory_dedupe_audit`).

**Memory indexes:**

- `idx_memories_embedding_cosine` — HNSW cosine index on `embedding`.
- `memories_user_content_unique_idx` — partial UNIQUE `(user_id, content)`
  for active rows (duplicate prevention).
- `idx_memories_content_fts` — GIN full-text index (new in 0009).
- `idx_memories_user_category_active`, `idx_memories_conflict_with`,
  `idx_memories_source_message` — supporting indexes.

**RLS:** 29 policies across all user tables. Every table has
`auth.uid() = user_id` SELECT/INSERT/UPDATE/DELETE policies.

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

---

## 11. Test results

Commands (PowerShell-compatible):

```powershell
npm test --prefix server     # 294 / 294 passed, 20 files
npm run typecheck            # server + client: clean
npm run build:server         # clean
npx tsc --noEmit             # client: clean (also run by build:client)
npm run build:client         # Next.js production build: success
```

| Gate | Result |
|---|---|
| Server tests | **294 passed / 294** (291 baseline preserved + 3 new hybrid tests) |
| Test files | 20 / 20 |
| Server typecheck | clean |
| Client typecheck | clean |
| Server build | clean |
| Client build | 6 routes generated, no errors |
| Secret scan of builds | no key values; only env-var names server-side |

Coverage spans authentication, tasks, reminders (including worker), memory
API, extraction worker/scheduler, embeddings, chat isolation and fallback,
OAuth callbacks/security, profile, integrations and metric regression tests.

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

1. Supabase project with migrations `0001`–`0010` applied in order.
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

## 18. Next development milestone

Milestone 5 has **not** been started. Recommended preconditions:

1. Run the same live checks against the real Supabase project once
   `SUPABASE_SERVICE_ROLE_KEY` is configured.
2. Verify Resend live delivery with an authorized test recipient.
3. Address rate limiting / `helmet` / API graceful shutdown.
4. Plan the Zod 4 upgrade.
5. Build a paraphrase-based retrieval dataset before tuning thresholds; the
   current benchmark over-rewards exact token matching.

Then Milestone 5 can begin from a clean, documented, fully green baseline.
