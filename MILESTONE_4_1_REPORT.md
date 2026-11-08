# Milestone 4.1 — Final Completion Report
### Memory Intelligence, Live Embeddings, Retrieval Evaluation & Repair

**Date:** 2026-11-06
**Status:** **Implementation complete; all automated quality gates pass.** One live end-to-end extraction run was not possible in this environment because the Supabase service-role credentials are absent from `server/.env` (details in §8).

---

## 0. Gate summary (all measured in this run)

| Gate | Command | Result |
|---|---|---|
| Server test suite | `npm test --prefix server` | **291 / 291 passed, 20 files** |
| Server typecheck | `tsc --noEmit` + test config | **clean** |
| Client typecheck | `npm run typecheck --prefix client` | **clean** |
| Monorepo typecheck | `npm run typecheck` | **clean** |
| Server build | `npm run build:server` | **clean** |
| Client build | `npm run build:client` | **clean** (Next.js 15.5.28, 6 routes) |
| Migrations 0007 + 0008 | applied to `chitti-pg` | **successful, idempotent re-run** |
| Partial unique index | `pg_indexes` | **UNIQUE** on `(user_id, content)` where status active/needs_review |
| Duplicate rejection | live `INSERT` | **rejected with 23505** |
| Category filtering | live `match_memories(..., 'career_goal')` | **5 rows, all career_goal** (40 without filter) |
| Atomic job claim | live `claim_memory_extraction_jobs` twice | 1 claimed, then **0** |
| RLS | `pg_policies` | policies present on memories, settings, jobs |
| Live retrieval benchmark | `evaluate-memory-retrieval.ts` | **P@5 0.2367 / Recall@5 0.5510 / MRR 0.4898** |
| Live embedding calls | 40 seeds + 49 queries | **Gemini succeeded** (no key/API errors) |

Baseline preserved: the previous 276-test suite is a strict subset of the
current 291 tests apart from three intentional changes — the eight failing
assertions were corrected to the fallback contract, the memory-list test
was updated to the new “active + needs_review” contract, and the
non-asserting `memory-eval` stub was replaced with real assertions. No test
was deleted, skipped, or made conditional.

---

## 1. Priority 0 — Quality gates restored

### TypeScript
- `memory.service.ts:210` now casts through `unknown` when materialising the
  insert row (`memRow as unknown as Memory`).
- Two pre-existing type errors in `scripts/evaluate-memory-retrieval.ts` and
  `tests/cross-conversation-persistence.test.ts` were also fixed (these had
  been masked by the first error).

### Eight failing tests
Root cause was **one change**: Task G's Gemini → Ollama fallback appended
`" (Ollama fallback also unavailable)"` to the client-facing error and
constructed the Ollama client eagerly, so `openaiConstructorCalls.at(-1)`
was Ollama.

Fixes (no assertions weakened):
1. The original Gemini `AiServiceError` is now rethrown unchanged after the
   fallback failure. The fallback failure is still logged server-side. This
   preserves the established client contract, avoids leaking provider
   internals, and keeps tool-calling semantics unchanged.
2. The Ollama client is created **lazily** on the first eligible fallback.
3. The Gemini-configuration test now selects the Gemini construction
   explicitly instead of assuming it is the last one.

No test was deleted, skipped, or made conditional.

---

## 2. Priority 1 — Extraction worker is now operational

**New:** `server/src/workers/extraction.scheduler.ts`

- Polls every 10 seconds (configurable).
- Each tick: `recover_stale_extraction_jobs()` → `claim_memory_extraction_jobs()`.
- Atomic claim stays in SQL (`FOR UPDATE SKIP LOCKED`).
- Single-flight guard: overlapping ticks share one promise.
- Errors are logged and the loop continues — extraction can never fail chat.
- `stop()` clears the timer and awaits the in-flight tick.
- Stale claims from a crashed worker are recovered on every tick.
- Bounded retries and permanent-failure tracking already live in
  `claimAndProcess` (MAX_ATTEMPTS = 3, `failed` + `error_message`).
- Duplicate prevention: exact-content conflict path + unique index (0007).

**Wired:** `server/src/worker.ts` now starts the reminder scheduler **and**
the extraction scheduler, and shuts both down with `Promise.allSettled`
before exiting.

**Tests:** `server/tests/extraction-scheduler.test.ts` (4 tests) — recovery
ordering, single-flight, error tolerance, stop/await behaviour.

---

## 3. Priority 2 — Database deduplication

**New:** `supabase/migrations/0007_memory_dedupe_unique_index.sql`

1. Creates `memory_dedupe_audit` (RLS enabled, service-role only) and records
   every duplicate it resolves.
2. For each `(user_id, exact content)` group among `active`/`needs_review`,
   keeps the active/oldest row and marks the rest `superseded`, linked to
   the keeper. **Rows are never deleted** — history is preserved.
3. Drops the non-unique `memories_user_content_unique_idx` and recreates it
   as a **partial UNIQUE index**.
4. Verifies no duplicates remain; raises and rolls back otherwise.

**Applied live:** no duplicates existed; index is now `CREATE UNIQUE INDEX`.
**Verified:** a direct duplicate `INSERT` failed with
`duplicate key value violates unique constraint "memories_user_content_unique_idx"`.
**Idempotent:** re-running produced only `NOTICE ... already exists` and
committed successfully.

---

## 4. Priority 3 — Category filtering

**New:** `supabase/migrations/0008_match_memories_category_and_conflict_link.sql`

- Replaces `match_memories` with a 5-argument version:
  `(query_embedding, p_user_id, match_threshold, match_count, p_category DEFAULT NULL)`.
- `p_category IS NULL` preserves the old 4-argument behaviour.
- Still `SECURITY INVOKER`, still filters `m.user_id = p_user_id`,
  still excludes superseded/expired/credential rows.
- Least-privilege grants re-applied after the `DROP FUNCTION`.

**Service:** `retrieveMemories` now sends `p_category`.
**Live proof:** with the same query vector, `p_category='career_goal'`
returned **5** rows (all `career_goal`); `NULL` returned **40**.
**Tests:** API-level category filter test added to `memory-api.test.ts`.

---

## 5. Priority 4 — Conflict lifecycle

- `listMemories` now returns **active + needs_review** by default and accepts
  `?status=active|needs_review`, `?category=`, and `?q=` (content search).
- `memories.conflict_with` links a review row to the memory it contradicts.
- `createMemory` stores that link when a contradiction is detected.
- `supersedeMemory` now:
  - rejects self-supersession,
  - verifies the replacement belongs to the same user,
  - marks the old row `superseded` (history preserved),
  - promotes the replacement to `active` and clears its conflict link.
- No silent overwrite anywhere.

**Tests added:** needs_review creation sets `conflict_with`; list includes
review rows; status filtering; replacement promotion/conflict clearing.

---

## 6. Priority 5 — Evaluation reliability

**New:** `server/src/evaluation/retrieval-metrics.ts` (pure functions).

- Rank is 1-based: first relevant → 1.0, second → 0.5, none → 0.
- P@5 = hits / 5; Recall@5 = hits / min(|expected|, 5).
- Aggregates are means over scored queries only.

**Benchmark rewritten:** 40 seeds, 51 queries (40 exact-token + 9 semantic +
1 irrelevant + 1 empty), known expected UUIDs, scoped cleanup of only the
benchmark's own rows. The previous arbitrary index mapping and the
`DELETE ... WHERE embedding_provider != ''` (which could delete other users'
data) are gone.

**Live result (actual):**

| Metric | Value |
|---|---|
| P@5 | 0.2367 |
| Recall@5 | 0.5510 |
| MRR | 0.4898 |
| Relevant retrieval rate | 55.10% |
| Irrelevant inclusion rate | 21.95% |
| Empty-query rejection | 100% |

**Tests:** `memory-eval.test.ts` now asserts all metric cases, cutoff,
de-duplication and aggregation with hand-computed values. The live benchmark
is not part of `npm test`.

---

## 7. Priority 6 — Memory dashboard

`client/src/components/memory/MemoryPanel.tsx` now provides:

- Search box (`GET /memories?q=...`).
- Category filter (`?category=...`).
- Status filter (`?status=active|needs_review`).
- Active and **Needs review** sections with counts.
- Conflict comparison: shows the existing memory's content and age.
- Explicit “Confirm replacement” flow calling the supersede endpoint.
- Created and modified timestamps on every row.
- Provenance/evidence display.
- Existing add/edit/delete, consent toggles, loading/error/success states.

Every control performs a real backend request (no client-only filtering).

`client/src/store/useMemoryStore.ts` accepts filters and forwards them as
query parameters.

---

## 8. Priority 7 — Live validation and remaining limitations

**Verified live on `chitti-pg` (PostgreSQL 16, pgvector 0.8.7):**

- migrations 0005–0008 applied; 0007/0008 re-ran idempotently;
- HNSW cosine index present;
- partial UNIQUE content index present and enforcing;
- duplicate insert rejected;
- category-aware `match_memories` returns only the requested category;
- RLS policies present on `memories`, `memory_settings`,
  `memory_extraction_jobs`;
- two successive claims produced 1 then 0 jobs (atomic claim);
- 40 live Gemini embeddings + 49 live query embeddings succeeded.

**Not executed live:**

- **End-to-end extraction through the worker process.** `server/.env` has an
  empty `SUPABASE_URL` and no `SUPABASE_SERVICE_ROLE_KEY`, and there is no
  local PostgREST/Supabase stack. The worker therefore cannot construct a
  service-role client here. The pipeline is covered by 291 green tests,
  including claim → extract → store → complete, retries, permanent failure,
  stale recovery, and scheduler lifecycle. **Manual step:** set
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, then run `npm run worker`
  and observe `pending → completed`.
- **Ollama live smoke** (embeddinggemma 768) was not re-run; it remains
  isolated-evaluation only and cannot serve the 1536-dim index.

**Retrieval quality limitation:** 21.95% irrelevant inclusion at threshold
0.65 is the main quality concern. The threshold remains user-configurable;
no tuning was applied in this milestone.

**Build warning (non-blocking):** Next.js reports multiple lockfiles and
infers the monorepo root. The build still succeeds.

**psql output note:** re-running 0007/0008 emits `NOTICE ... already exists`
on stderr, which PowerShell renders in red; both scripts still reached
`COMMIT`. This is expected for idempotent DDL.

---

## 9. Files added / changed in this completion pass

**Added**
- `server/src/workers/extraction.scheduler.ts`
- `server/src/evaluation/retrieval-metrics.ts`
- `server/tests/extraction-scheduler.test.ts`
- `supabase/migrations/0007_memory_dedupe_unique_index.sql`
- `supabase/migrations/0008_match_memories_category_and_conflict_link.sql`

**Changed**
- `server/src/services/ai.service.ts` — lazy Ollama client; original error preserved
- `server/src/services/memory.service.ts` — category RPC arg, conflict link, supersession promotion
- `server/src/controllers/memory.controller.ts` — review rows + q/category/status filters
- `server/src/worker.ts` — extraction scheduler lifecycle
- `server/scripts/evaluate-memory-retrieval.ts` — rewritten dataset/metrics/safety
- `server/tests/ai-tools.test.ts`, `chat-isolation.test.ts`, `memory-api.test.ts`,
  `memory-eval.test.ts`, `cross-conversation-persistence.test.ts`,
  `helpers/fakeSupabase.ts`
- `shared/types.ts`, `client/src/types.ts`, `client/src/store/useMemoryStore.ts`,
  `client/src/components/memory/MemoryPanel.tsx`
- `MEMORY_EVALUATION_REPORT.md`, `MILESTONE_4_1_PROGRESS.md`, this report

---

## 10. Manual deployment checklist

1. Start Docker Desktop and `chitti-pg` (port 55432).
2. Apply migrations in order: `0005`, `0006`, `0007`, `0008`.
3. Set in `server/.env`:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `GEMINI_API_KEY`, `GEMINI_MODEL`
   - `EMBEDDING_PROVIDER=gemini`, `GEMINI_EMBEDDING_MODEL=gemini-embedding-2`
   - optional `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_EMBEDDING_MODEL`
4. `npm run dev:server` and `npm run worker`.
5. In the dashboard, enable “Automatic memory extraction” (default OFF).
6. Verify a job reaches `completed` and a memory appears in the list.
7. Optional: `npx tsx server/scripts/evaluate-memory-retrieval.ts`.

Milestone 5 was not started.

---

# Milestone 4.2 stabilization addendum (2026-11-08)

This addendum supersedes the "live validation could not be performed"
statements above. Full detail is in `PROJECT_STATUS_REPORT.md`.

## Gates

| Gate | Result |
|---|---|
| Server tests | **294 / 294** (291 baseline preserved, 3 hybrid-retrieval tests added) |
| Server typecheck | clean |
| Client typecheck | clean |
| Server build | clean |
| Client build | clean |
| Baseline benchmark reproduction | exact (P@5 0.2367, R@5 0.5510, MRR 0.4898) |

## Retrieval improvement

`match_memories()` now supports optional hybrid lexical retrieval
(migration `0009`). Measured on the same embeddings and dataset:

| Metric | Vector (before) | Hybrid (after) |
|---|---|---|
| P@5 | 0.2367 | **0.3265** |
| Recall@5 | 0.5510 | **1.0000** |
| MRR | 0.4898 | **1.0000** |
| Irrelevant inclusion | 0.2195 | 0.2195 (unchanged) |
| Empty-query rejection | 1.00 | 1.00 |
| Avg DB RPC latency | ~51�54 ms | ~57�59 ms |

The improvement is concentrated in exact-token queries; semantic-query
quality is unchanged. Only one embedding call per query is made and no LLM
reranker was added. `query_text` is optional, so callers that omit it keep
the previous pure-vector behaviour.

## Operational verification (live, isolated stack)

- **Memory extraction verified end-to-end** through the real scheduler:
  claim ? structured extraction ? 1536-dim embedding ? insertion with
  provenance ? completion ? independent retrieval. Duplicate prevention,
  consent-off, permanent failure, stale-claim recovery and credential
  rejection all behaved correctly.
- **Reminder worker verified** with a mock provider: claim/send/status,
  duplicate prevention, retry backoff, exhaustion, stale recovery, and
  future/cancelled exclusion.
- **Database verified live** (rolled-back SQL): category filtering, user
  isolation, duplicate `23505`, both atomic claim paths, stale recovery,
  reschedule/cancel, RLS.

## Fixed

- `service_role` EXECUTE on `match_memories` was missing (worker conflict
  detection silently disabled) ? migration `0009`.
- `service_role` lacked `messages` / `reminders` grants (worker could not
  read source messages on non-Supabase-managed Postgres) ? migration `0010`.

## Still blocked by configuration

- Resend live delivery: `RESEND_API_KEY` not set; mock provider only.
- Remote Supabase project: `SUPABASE_SERVICE_ROLE_KEY` not set; live tests
  ran against a local PostgREST + PostgreSQL stack instead.
