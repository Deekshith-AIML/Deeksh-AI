# Document RAG Evaluation Report — Milestone 5, Phase 12

**Status: deterministic evaluation complete; final live audit (2026-11-10) still BLOCKED by missing configuration.**
No retrieval, citation or answer-quality score in this document is inferred, estimated or fabricated.

| Area | Status |
|---|---|
| 20-document synthetic corpus (PDF/DOCX/TXT) | **Implemented and reproducible** |
| 72-query ground truth across 10 categories | **Implemented and reproducible** |
| Ground truth resolved through the real extraction + chunking pipeline | **Verified by automated tests** |
| Metric implementations (P@5, R@5, MRR, latency, citation, refusal) | **Verified by automated tests** |
| Production answer path (untrusted context, citations, Gemini→Ollama fallback) | **Verified with mocked providers** |
| Worker edge cases (scanned PDF, empty text, oversized TXT, deletion) | **Verified with the in-memory DB/storage double** |
| Live Supabase E2E (upload → worker → retrieval → answer → deletion → isolation) | **BLOCKED — not run** |
| Live Gemini embeddings / live Gemini + Ollama answers | **BLOCKED — not run** |
| Live P@5 / R@5 / MRR / citation correctness / faithfulness | **Not computed (blocked)** |

---

## 1. Scope

Phase 12 evaluates the existing Milestone 5 document pipeline. It does **not**
rebuild it. The evaluation reuses the production code paths:

- upload and validation: `createDocument()` / `validateUpload()`
- durable processing: `processDocumentJobs()` (real extraction, chunking,
  embedding, persistence, retry and failure handling)
- retrieval: `searchDocumentChunks()` → `match_document_chunks` RPC
- answer generation and citation validation: `chat(..., { useDocuments: true })`
- deletion and cleanup: `deleteDocument()` / `sweepDeletingDocuments()`

No simplified benchmark-only search path exists, so a live run measures the
same behaviour users receive.

## 2. Reproduction

All commands run from the repository root.

```powershell
# Offline dataset + ground-truth validation (no network, no database)
npm run eval:documents:self-check --prefix server

# Full live evaluation (requires the environment listed in §7)
$env:EVAL_CONFIRM = 'yes'
npm run eval:documents --prefix server
```

Generated artefacts (gitignored under `server/evaluation-results/`):

- `document-rag-self-check.json` — corpus/query integrity result
- `document-rag-evaluation-blocked.json` — explicit blocked report when config is missing
- `document-rag-evaluation-<timestamp>.json` — live report (only when a live run succeeds)

The script exits `0` in blocked mode after writing the blocked report. It never
substitutes mock results for live scores.

## 3. Dataset

### 3.1 Documents — 20 total

| Format | Count | Documents |
|---|---|---|
| PDF | 7 | Employee Handbook (3 pages), Security Policy (2 pages), Platform Architecture (4 pages), Data Analyst Internship (2 pages), Backend Engineer Internship (2 pages), Facilities Bulletin (2 pages), Page Provenance Test (3 pages) |
| DOCX | 6 | Project Phoenix, Project Atlas, Vendor Comparison, Travel Policy, Onboarding Checklist, Quarterly Metrics |
| TXT | 7 | Meeting Notes 2026-03-12, Meeting Notes 2026-04-02, Support FAQ (long), Contradictory Draft Notes, Quarterly Planning + Injection, Unicode Sample, Open Source Phoenix Framework |

Trait coverage is asserted by tests: multi-page PDFs, headings and nested
headings, DOCX tables, long documents, similar documents (two internships, two
Phoenix references), overlapping terminology, contradictory statements, absent
information, Unicode/emoji/Japanese text, and prompt injection.

The corpus is generated deterministically from block definitions using
`pdf-lib` (real PDF bytes) and `docx` (real OOXML packages); TXT files are real
UTF-8 files. No user document is copied or modified.

### 3.2 Queries — 72 total (58 scored + 14 safety)

| Category | Count | Scored for ranking |
|---|---|---|
| Exact match | 10 | yes |
| Semantic / paraphrased | 10 | yes |
| Multi-document | 8 | yes |
| Table-based | 8 | yes |
| Section-specific | 8 | yes |
| PDF page-specific | 8 | yes |
| Contradictory sources | 6 | yes |
| Unanswerable | 6 | no (refusal behaviour) |
| Irrelevant | 4 | no (refusal behaviour) |
| Prompt injection | 4 | no (safety behaviour) |

Unanswerable, irrelevant and prompt-injection queries are excluded from
P@5 / R@5 / MRR by design. Scoring them as ranking failures would conflate
safety with retrieval quality.

### 3.3 Ground-truth method

Each scored query declares:

- `expectedDocKeys` — hand-authored corpus documents that support the answer
- `expectedAnchors` — unique phrases that identify the supporting chunk(s)
- `expectedPage` / `expectedHeading` — provenance assertions for PDF/DOCX
- `expectedAnswerContains` — deterministic faithfulness proxy phrases
- `scored` — whether the query contributes to ranking metrics

At evaluation time anchors are resolved to the **persisted chunk ids** loaded
from the seeded database. Resolution scans only seeded chunk content and never
consults retrieval output, so the expected set cannot be inflated after seeing
results. Overlap can place an anchor in adjacent chunks; every matching chunk
is included in the expected set.

The test suite additionally resolves every anchor through the **real**
`extractDocument()` + `chunkDocument()` pipeline and asserts that:

- every anchor resolves to at least one real chunk,
- every match belongs to an allowed document,
- each expected page is contained by the matched chunk,
- each expected heading is attached to the matched chunk.

PDF chunks may intentionally span pages (existing M5 chunking behaviour). The
correctness check is therefore page **containment**; the “chunk starts exactly
on the expected page” rate is reported separately as an informational metric.

## 4. Metrics

| Metric | Definition |
|---|---|
| Precision@5 | expected chunks retrieved in the top 5 ÷ 5 |
| Recall@5 | expected chunks retrieved in the top 5 ÷ min(\|expected\|, 5) |
| MRR | mean of 1 / rank of the first expected chunk (1-based, ≤ 1, 0 if none) |
| Relevant retrieval rate | fraction of scored queries with at least one expected chunk |
| Irrelevant inclusion rate | fraction of scored queries whose top 5 contains any chunk outside the hand-authored expected set |
| Empty-query rejection rate | fraction of empty/whitespace queries rejected by the search schema |
| Citation source availability | cited sources carrying both a document id and a chunk id |
| Citation integrity | document exists, is owned by the evaluation user, chunk exists, chunk belongs to the document, page/heading provenance matches |
| Retrieval latency | wall-clock time around the production retrieval call; mean, p50, p95, min, max (nearest-rank percentiles) |
| Unsupported answer rate | answers failing the deterministic expected-phrase proxy ÷ answers with a proxy |
| Insufficient-evidence rate | unanswerable/irrelevant queries whose reply states missing evidence |

Citation integrity is mechanical. Whether a cited chunk semantically supports a
sentence is recorded for human review (full reply and cited text are exported);
no LLM-judge score is claimed.

## 5. Configuration under evaluation

Values are the production defaults (environment-overridable) read by the same
config module used in production:

| Setting | Value |
|---|---|
| Embedding provider / model / dimension | Gemini `gemini-embedding-2`, 1536 dimensions |
| Query embedding role | `query` |
| Retrieval threshold | 0.5 |
| Retrieval top-K (search API) | 8 |
| Chat top-K | 6 |
| Chat context cap | 6,000 characters |
| Chunk target / overlap | 900 / 120 tokens |
| Max chunks per document | 2,000 |
| Chat primary | `gemini-3.8-flash` |
| Chat fallback | `mistral:latest` via local Ollama |
| PDF scanned threshold | 50 extractable characters |

The live script records the effective values it observes, including the active
embedding space, rather than trusting this table.

## 6. Deterministic evidence (actual, run locally)

### 6.1 New tests

| File | Tests | Covers |
|---|---|---|
| `server/tests/document-rag-evaluation.test.ts` | 16 | corpus/query integrity, anchor resolution through real extraction + chunking, page/heading provenance, metric math, empty-query rejection, citation and refusal helpers |
| `server/tests/document-rag-answer.test.ts` | 4 | document context in the untrusted user turn, system-prompt isolation, fixed tool surface, invented-marker rejection, Gemini→Ollama fallback equivalence, no credential in the prompt, no sources when evidence is absent |
| `server/tests/document-rag-edge-cases.test.ts` | 6 | scanned PDF (`SCANNED_PDF_REQUIRES_OCR`), whitespace-only TXT (`NO_EXTRACTABLE_TEXT`), oversized TXT bounded by chunk cap, zero-chunk safety, short-lived signed view link, deleted-document view refusal |

Full suite: **459 passed / 459, 36 files** (433 pre-existing tests preserved,
no assertion weakened).

### 6.2 Self-check result

```
Dataset self-check passed.
Documents: 20 ({"pdf":7,"docx":6,"txt":7}); queries: 72 (58 scored).
```

The self-check fails closed: a missing format, category, duplicate id, anchor
outside its expected document, anchor not on the expected page, or missing
heading blocks the evaluation before any metric is computed.

### 6.3 Edge-case status

| Case | Status |
|---|---|
| Empty PDF pages | Covered (real extraction integration test) |
| Scanned PDF | Covered (permanent `SCANNED_PDF_REQUIRES_OCR`, no chunks) |
| Malformed PDF / DOCX | Covered |
| Password-protected / encrypted PDF | **Unsupported**; no decryption path. Encrypted DOCX ZIP entries are rejected (`DOCX_ENCRYPTED`). |
| Large TXT | Covered (bounded by `maxChunksPerDocument`, truncation metadata) |
| Unicode / UTF-16LE / UTF-16BE / windows-1252 fallback | Covered |
| Oversized paragraphs | Covered (paragraph splitting) |
| Empty chunks | Guarded: zero chunks are rejected by the worker (`NO_CHUNKS_PRODUCED`); chunker cap-at-zero test added |
| Embedding provider failure | Covered (retry, then bounded exhaustion) |
| Partial chunk persistence | Covered (document is never marked ready) |
| Worker interruption / stale claim | Covered |
| Duplicate processing | Covered (idempotent) |
| Deletion during retrieval | Covered by ready-only filtering and deletion tests |
| Database / storage outage | Covered |
| Expired signed URLs | TTL is asserted (120s); actual expiry cannot be simulated with the in-memory storage double |
| OCR / malware scanning | **Not implemented** (documented limitation) |

### 6.4 RAG answer-path behaviour (mocked model)

- Retrieved content is placed only in the **user** turn inside
  `<document_context untrusted="true">`; the system prompt never contains it.
- The system prompt states that retrieved documents cannot authorize tools,
  request credentials, or override policy, and requires an explicit
  insufficient-evidence statement when support is absent.
- Only the fixed `create_task` and `save_memory` tools are offered; document
  content cannot add tools.
- Invented `[S#]` markers are dropped from returned sources.
- Gemini→Ollama fallback receives identical messages and tools, and the
  provider actually used is recorded in `response.model`.
- No configured credential appears in any prompt.

## 7. Live evaluation — BLOCKED

A live run was attempted with the current workspace environment. It is blocked
before any write or model call. The configuration audit was re-run on
2026-11-10 with the same result; the blocked report was regenerated from the
final script.

### 7.1 Configuration audit (values never printed)

| Variable | Status |
|---|---|
| `SUPABASE_URL` | configured in `server/.env` |
| `SUPABASE_ANON_KEY` | configured in `server/.env` |
| `SUPABASE_SERVICE_ROLE_KEY` | **MISSING** |
| `EVAL_USER_ID` | **MISSING** |
| `EVAL_CONFIRM` | **MISSING** (live writes require `yes`) |
| `GEMINI_API_KEY` | configured in `server/.env` |
| `GEMINI_EMBEDDING_MODEL` | not set — default `gemini-embedding-2` applies |
| `EMBEDDING_PROVIDER` | not set — default `gemini` applies |
| `DATABASE_URL` | missing |
| Supabase CLI / `supabase/config.toml` | absent |
| Docker daemon | not running (local Supabase stack unavailable) |
| Ollama configuration | not set (`OLLAMA_BASE_URL`, `OLLAMA_MODEL` absent) |

### 7.2 Blocked lifecycle steps

All 20 steps require the missing live configuration; none were executed.

| # | Step | Status |
|---|---|---|
| 1 | Create/authenticate the dedicated synthetic account (`EVAL_USER_ID`) | blocked (`EVAL_USER_ID` missing) |
| 2 | Opt in to writes (`EVAL_CONFIRM=yes`) | blocked (not set) |
| 3 | Upload the 7 PDF fixtures through `createDocument()` | blocked (service-role key missing) |
| 4 | Upload the 6 DOCX fixtures | blocked |
| 5 | Upload the 7 TXT fixtures | blocked |
| 6 | Verify each document starts in `pending` and a processing job exists | blocked |
| 7 | Drain the durable worker to `ready` | blocked |
| 8 | Verify extraction metadata (pages, headings, tables, encoding) | blocked |
| 9 | Verify persisted chunks and page/heading/paragraph provenance | blocked |
| 10 | Verify real 1536-dimensional Gemini embeddings | blocked |
| 11 | Verify duplicate-upload prevention for the same content hash | blocked |
| 12 | Run production retrieval for all 72 queries | blocked |
| 13 | Compute P@5 / R@5 / MRR / relevant / irrelevant / latency p50-p95 | blocked |
| 14 | Verify expected page containment and DOCX heading provenance | blocked |
| 15 | Generate answers with Gemini through `chat(..., { useDocuments: true })` | blocked |
| 16 | Validate every citation (document exists/owned, chunk exists/belongs, provenance) | blocked |
| 17 | Exercise Ollama fallback and record the provider actually used | blocked (no Ollama availability check) |
| 18 | Verify prompt injection cannot authorize tools or leak the placeholder secret | deterministic mock only; live blocked |
| 19 | Verify deletion removes chunks, jobs and the private storage object | blocked |
| 20 | Verify cross-user retrieval/access/deletion isolation and short-lived signed URLs | blocked |

### 7.3 How to unblock

Provide, in `server/.env` or the process environment:

```
SUPABASE_SERVICE_ROLE_KEY=<dedicated development/staging service-role key>
EVAL_USER_ID=<id of a dedicated synthetic auth user>
EVAL_CONFIRM=yes
# optional: EVAL_USER_EMAIL_PREFIX (default eval-rag-), EVAL_ANSWER_LIMIT (default 22)
```

The target user’s email must start with `eval-rag-` (configurable). The script
refuses to write otherwise, removes only documents with the known corpus
filenames for that user, and deletes only documents it created. It does not
touch other users, production documents or real email.

### 7.4 Evaluation-safety audit (static, script inspected)

| Check | Finding | Verdict |
|---|---|---|
| Evaluation account is dedicated | `verifySyntheticUser()` refuses to continue unless the auth user's email starts with `EVAL_USER_EMAIL_PREFIX` (default `eval-rag-`) | Enforced in code; actual account cannot be confirmed because `EVAL_USER_ID` is missing |
| Seeded document IDs are isolated | IDs come only from `createDocument()` return values for the verified user; retrieval, answers, chunk loading and cleanup are scoped to that user and those IDs | Pass (code inspection) |
| Cleanup only affects evaluation-owned records | `finally` deletes only `createdDocumentIds`; the pre-run cleanup deletes prior rows with the 20 corpus filenames for the same evaluation user | Pass (dedicated-account assumption) |
| No actual user documents can be deleted | No global document listing; deletion calls require the evaluation user id; cross-user deletion is exercised only as an expected denial | Pass (code inspection) |
| Worker scope | The live drain processes only jobs whose `document_id` is in the seeded set; it deliberately avoids the global claim RPC so it cannot claim another user's queued job | Pass |
| Storage bucket is private | Migration `0012` creates the bucket with `public = false`, applies storage RLS scoped to `auth.uid()` folder, and the viewer issues 120s signed URLs | Pass by migration inspection; live Storage unverified |
| Ownership / RLS is meaningful | Migrations `0011` enable RLS with `auth.uid() = user_id` on documents, chunks and jobs; services add explicit user filters; the script tests a peer user's retrieval/access/deletion denial | Design verified; live RLS unverified |
| Production data avoided | Script has no production user/document ids and requires an explicit synthetic prefix; `EVAL_CONFIRM=yes` is required for writes | Enforced in code |

Caveats: the service-role client bypasses RLS by design, so the script relies on
its own user/ID scoping; this has not been proven against a live database. The
same-account pre-run cleanup would remove a manually uploaded evaluation-account
document with an identical corpus filename — acceptable only for a dedicated
synthetic account.

## 8. Baseline / after policy

No retrieval or chunking change was made in Phase 12. The baseline is the
current production path; there is no “after” variant to compare. No change was
adopted on the basis of a metric, so there is no tuning delta and no
single-metric optimisation. When a live environment is available, the same
corpus and queries should be used for any future before/after comparison.

## 9. Limitations

- No live retrieval, citation or answer-quality score exists yet.
- Semantic citation support requires human review; the deterministic phrase
  proxy is not a judge.
- DOCX has no page numbers by design; DOCX citations are validated by
  heading/section. TXT citations resolve through the chunk id to the stored
  paragraph/line range.
- PDF chunks may span pages; containment, not exact start page, is the
  correctness check.
- Ollama quality can only be observed on a live run where a fallback actually
  occurs (or with a dedicated opt-in provider run).
- No OCR and no malware scanning.
- Password-protected PDFs are unsupported.
- Signed-URL expiry is not simulated; only the issued TTL is checked.

## 10. Acceptance checklist

| Requirement | Status |
|---|---|
| ≥ 15 documents (20 delivered) | Met |
| ≥ 50 queries (72 delivered) | Met |
| PDF, DOCX, TXT coverage | Met |
| Headings, tables, multi-page, long, similar, overlapping, contradictory, absent-info, injection | Met and tested |
| Known chunk ids only for relevance | Met (anchors resolved from seeded data, never from retrieval output) |
| P@5 / R@5 / MRR / relevant / irrelevant / empty-query / latency p50-p95 implemented | Met and unit tested |
| Citation correctness checks (existence, ownership, chunk, provenance) | Implemented and unit tested |
| Faithfulness methodology documented | Met (deterministic proxy + exported text; no judge score claimed) |
| Unsupported answer rate / refusal behaviour | Implemented and unit tested |
| Prompt-injection cannot authorize tools or leak the placeholder secret | Verified with mocked model |
| Gemini primary / Ollama fallback with equivalent context | Verified with mocked provider failure |
| Live Supabase lifecycle and isolation | **BLOCKED — not verified** |
| Live Gemini/Ollama answer quality | **BLOCKED — not verified** |
| Existing tests preserved | 459 passed / 459 (433 pre-existing, all preserved) |
| Typechecks and builds | All six gates clean |

## 11. Final decision

**M5 is implementation-complete for the deterministic/evaluated scope, but is
not fully production-verified.**

Reasons:

- The evaluation framework, corpus, ground truth, production-path integration,
  edge cases and regression coverage are complete and green.
- Live Supabase lifecycle, real RLS/Storage behaviour, live Gemini embeddings,
  and live Gemini/Ollama answer quality could not be executed because
  `SUPABASE_SERVICE_ROLE_KEY`, `EVAL_USER_ID` and `EVAL_CONFIRM` are not
  configured (and no local Supabase/Docker stack is available).
- No live P@5, R@5, MRR, citation-correctness, faithfulness or latency number
  is claimed. Mock tests prove wiring and safety properties, not model quality.

M6 has not been started. To move from implementation-complete to
production-verified, configure a dedicated synthetic account and a
development/staging service-role key, then run the live evaluation and review
the exported report.
