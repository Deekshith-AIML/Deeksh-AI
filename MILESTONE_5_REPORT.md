# DEEKSH AI — Milestone 5 Report
# Personal Knowledge Base & Retrieval-Augmented Generation

**Status:** PHASE 2 COMPLETE — schema, storage, validation, upload/list/rename/delete/view APIs, and test infrastructure implemented. Retrieval, chunking, extraction, worker, RAG, citations, frontend, and evaluation are **not yet implemented**.

**Date:** 2026-11-08  
**Branch:** `stabilization/m4.2` (HEAD `4f8e8e7` + Phase 2 changes)  
**Baseline preserved:** `8c61e5b` (M4.2 checkpoint `ba180ae`)

---

## 1. Summary of changes

| Area | Files | Description |
|---|---|---|
| **Migrations** | `supabase/migrations/0011_documents_schema.sql` | Three new tables (`documents`, `document_chunks` with `vector(1536)` + HNSW, `document_processing_jobs`), RLS policies, `updated_at` triggers, `match_document_chunks()` RPC, `claim_document_processing_jobs()` / `recover_stale_document_jobs()` worker functions (service_role only). |
| | `supabase/migrations/0012_documents_storage.sql` | Guarded bucket creation + storage policies for private `documents` bucket at `{user_id}/{document_id}/{uuid}.{ext}`. Skips cleanly on plain PostgreSQL (local harness). |
| **Shared types** | `shared/types.ts` | `ChatRequest.document_ids`, `use_documents`; `ChatResponse.sources[]`, `document_context_used`; full `KnowledgeDocument`, `DocumentChunkPreview`, `DocumentSearchHit`, `DocumentViewResponse`, enums, metadata interfaces. |
| **Shared schemas** | `shared/schemas.ts` | `chatRequestSchema` extended; `documentListQuerySchema`, `documentRenameSchema`, `documentSearchSchema`, `documentExtensionSchema`, `documentStatusSchema`, `documentIdParamSchema`; exported inferred types. |
| **Config** | `server/src/config/documents.config.ts` | Central env-overridable config (25 MiB upload, 900/120 chunking, 0.50 threshold, 6k context, 3× embed concurrency, 10 uploads/min, 60 searches/min, worker 5s/3-batch, exponential backoff). |
| **Errors** | `server/src/services/documents/errors.ts` | `DocumentError`, `DocumentValidationError` with stable codes and HTTP status. |
| **Validation** | `server/src/services/documents/validation.ts` | Extension allow-list, filename normalisation, **magic-byte checks** (PDF `%PDF-`+`%%EOF`, DOCX ZIP+`[Content_Types].xml`+`word/document.xml`, TXT UTF-8/16/1252, no NUL, <1% controls), **DOCX zip-bomb preflight** (entry count, total uncompressed, per-entry ratio, encrypted entries). |
| **Storage adapter** | `server/src/services/storage/` | `StorageProvider` interface; `SupabaseStorageProvider` (user-scoped client → storage RLS; service_role for worker); `LocalStorageProvider` (`STORAGE_PROVIDER=local`, `LOCAL_STORAGE_DIR`, signedUrl→null, API streams bytes). |
| **Document service** | `server/src/services/documents/document.service.ts` | Upload (validate→dedupe→store→metadata→job→pending), list (q/type/status/limit/offset), details (+job), chunks preview, rename, retry (clears chunks, resets job), delete (mark `deleting`→chunks→storage→`deleted`, worker sweeper retries on storage failure), view link (signed URL or local content route). |
| **Middleware** | `server/src/middleware/upload.middleware.ts` | `multer.memoryStorage`, 1 file, 25 MiB limit, safe error translation. |
| | `server/src/middleware/rate-limit.middleware.ts` | In-process per-user token buckets (upload 10/min, search 60/min), `Retry-After` header, test reset hook. |
| **Controller** | `server/src/controllers/document.controller.ts` | 9 handlers: upload, list, get, rename, delete, retry, view, chunks, content (local). All verify ownership via `getAuth` + user-scoped client. |
| **Routes** | `server/src/routes/document.routes.ts` | `GET/POST /api/documents`, `GET/PATCH/DELETE /api/documents/:id`, `POST /api/documents/:id/retry`, `GET /api/documents/:id/view`, `GET /api/documents/:id/content`, `GET /api/documents/:id/chunks`. Auth + rate limits on upload/search. |
| **App** | `server/src/app.ts` | Mounted `/api/documents` router. |
| **Test fake** | `server/tests/helpers/fakeSupabase.ts` | Added `FakeDocument`, `FakeDocumentChunk`, `FakeDocumentJob`; state arrays; `rowsFor` + delete branches; `ilike` support; RPC stubs for `match_document_chunks`, `claim_document_processing_jobs`, `recover_stale_document_jobs`; fake storage surface (`storage.from().upload/download/remove/createSignedUrl`); seeded object helpers; `fakeStorage` test view; `injectStorageFailure`, `seedStoredObject`. |

---

## 2. Database verification (local `chitti-pg`)

| Check | Result |
|---|---|
| Tables created | `documents`, `document_chunks`, `document_processing_jobs` ✓ |
| HNSW index | `idx_chunks_embedding_cosine` on `document_chunks.embedding vector_cosine_ops` ✓ |
| Unique indexes | `documents_user_hash_unique` (live rows only), `document_chunks_unique_index`, `doc_jobs_one_active` ✓ |
| RLS enabled | All three tables, 12 policies (`auth.uid() = user_id`) ✓ |
| RPC `match_document_chunks` | Exists, `SECURITY INVOKER`, granted to `authenticated` + `service_role` ✓ |
| Worker functions | `claim_document_processing_jobs`, `recover_stale_document_jobs` — `SECURITY DEFINER`, granted to `service_role` only ✓ |
| Constraints verified | Path ownership (`storage_path LIKE user_id::text || '/%'`), duplicate hash, single active job ✓ |
| Smoke test | Insert → claim → match → user isolation → status filter (deleting excluded) — all pass ✓ |
| Guarded storage migration | Logs notice and skips on plain PostgreSQL ✓ |

---

## 3. Tests

| Suite | Result |
|---|---|
| Existing 294 baseline tests | **All pass** (20 files) |
| Server typecheck (`tsc --noEmit`) | **Clean** |
| Client typecheck (`tsc --noEmit`) | **Clean** |

No new unit/integration tests written yet (Phase 3+). The fake Supabase is ready for them.

---

## 4. Environment variables (to be added to `.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `MAX_UPLOAD_BYTES` | `26214400` | 25 MiB upload cap |
| `DOCUMENTS_BUCKET` | `documents` | Supabase storage bucket name |
| `STORAGE_PROVIDER` | `supabase` | `supabase` \| `local` (dev only) |
| `LOCAL_STORAGE_DIR` | `server/.local-storage` | Local adapter root |
| `DOC_CHUNK_TARGET_TOKENS` | `900` | Chunk target size |
| `DOC_CHUNK_OVERLAP_TOKENS` | `120` | Overlap |
| `DOC_MAX_CHUNKS_PER_DOCUMENT` | `2000` | Hard cap |
| `DOC_MAX_TEXT_CHARS` | `2000000` | Extraction cap |
| `DOC_RETRIEVAL_THRESHOLD` | `0.50` | Similarity floor |
| `DOC_RETRIEVAL_TOP_K` | `8` | KB search results |
| `DOC_CHAT_TOP_K` | `6` | Chunks per chat turn |
| `DOC_MAX_CONTEXT_CHARS` | `6000` | Prompt budget |
| `DOC_EMBED_CONCURRENCY` | `3` | Embedding workers |
| `EXTRACTION_TIMEOUT_MS` | `30000` | Parse timeout |
| `DOC_MIN_EXTRACTABLE_CHARS` | `50` | Scanned-PDF threshold |
| `DOCX_MAX_ENTRIES` | `2000` | ZIP entry cap |
| `DOCX_MAX_UNCOMPRESSED_BYTES` | `209715200` | ZIP bomb guard |
| `DOCX_MAX_COMPRESSION_RATIO` | `100` | Ratio guard |
| `DOC_RATE_LIMIT_UPLOADS_PER_MIN` | `10` | Per-user upload limit |
| `DOC_RATE_LIMIT_SEARCHES_PER_MIN` | `60` | Per-user search limit |
| `DOC_WORKER_INTERVAL_MS` | `5000` | Worker poll interval |
| `DOC_WORKER_BATCH_SIZE` | `3` | Jobs per tick |
| `DOC_RETRY_BASE_DELAY_MS` | `5000` | Exponential backoff base |

**Real `.env` files are not modified.** `SUPABASE_SERVICE_ROLE_KEY` remains absent (live ingestion blocked — see §6).

---

## 5. API contract (implemented in Phase 2)

| Method | Path | Auth | Body / Query | Response |
|---|---|---|---|---|
| POST | `/api/documents` | ✓ | `multipart/form-data` `file` | 201 `{ document: KnowledgeDocument }` |
| GET | `/api/documents` | ✓ | `q`, `type`, `status`, `limit`, `offset` | `{ documents[], count }` |
| GET | `/api/documents/:id` | ✓ | — | `{ document, job }` |
| PATCH | `/api/documents/:id` | ✓ | `{ original_filename }` | `{ document }` |
| DELETE | `/api/documents/:id` | ✓ | — | `{ document }` (marks `deleting`→`deleted`) |
| POST | `/api/documents/:id/retry` | ✓ | — | 202 `{ document }` (re-queues failed) |
| GET | `/api/documents/:id/view` | ✓ | — | `{ url, extension, page_count, expires_in }` |
| GET | `/api/documents/:id/content` | ✓ | — | `application/octet-stream` (local provider only) |
| GET | `/api/documents/:id/chunks` | ✓ | `limit`, `offset` | `{ chunks[], count }` |

Error envelope: `{ error, code, details? }` with stable codes (`UNSUPPORTED_EXTENSION`, `FILE_TOO_LARGE`, `MALFORMED_FILE`, `DUPLICATE_DOCUMENT`, `DOCUMENT_NOT_FOUND`, `DOCUMENT_NOT_VIEWABLE`, `STORAGE_WRITE_FAILED`, etc.).

---

## 6. Known limitations / blockers (honest status)

| # | Issue | Impact | Mitigation |
|---|---|---|---|
| 1 | `SUPABASE_SERVICE_ROLE_KEY` missing in `server/.env` | Live ingestion against real Supabase project blocked; storage policies cannot be live-verified. | Local `STORAGE_PROVIDER=local` + PostgREST shim for end-to-end verification, reported as **isolated verification**. |
| 2 | No Supabase Storage in local PostgreSQL harness | Storage policies & signed URLs untested against real Storage. | Guarded migration `0012` skips cleanly; fake storage in tests; production uses private bucket. |
| 3 | No malware scanner configured | Must not be claimed as implemented. | Validation only; documented as future work. |
| 4 | No OCR pipeline | Scanned PDFs fail with `SCANNED_PDF_REQUIRES_OCR`. | Explicitly not faked; marked in `extraction_metadata.scanned=true`. |
| 5 | In-process rate limits are per-instance | Multi-instance deployments need shared counter. | Documented as abuse guard, not security boundary. |
| 6 | Retrieval threshold 0.50, chunking 900/120 are defaults | Need tuning via evaluation. | Will be adjusted by evaluation report (§8). |
| 7 | No tests for Phase 2 functionality yet | Upload/validation/service/middleware untested. | Fake is ready; tests scheduled for Phase 3+. |

---

## 7. Remaining phases (roadmap)

| Phase | Deliverable | Target |
|---|---|---|
| 3 | PDF/DOCX/TXT extraction (`pdfjs-dist`, `mammoth`+`jszip`) | Unit tests + in-memory fixtures (`pdf-lib`, `docx`) |
| 4 | Structure-aware chunking (headings, paragraphs, pages, tables) | Chunk boundaries, overlap, provenance, cap tests |
| 5 | Embeddings + chunk persistence (reusing `embed()`, 1536-dim lock, mocks) | Dimension/space validation tests |
| 6 | Durable worker + scheduler (`document.worker.ts`, `document.scheduler.ts`) | Atomic claim, stale recovery, bounded retries, graceful shutdown |
| 7 | `match_document_chunks` RPC + retrieval service | Relevance, isolation, filtering, provenance tests |
| 8 | RAG integration in `ai.service.chat()` | Single query embedding, heuristic doc scope, context block, citation markers, prompt isolation |
| 9 | Citation validation & `ChatResponse.sources[]` | Server-side marker parsing, resolvable sources only |
| 10 | Knowledge Base UI + chat citations | `KnowledgeBasePanel`, `DocumentUpload`, `DocumentList`, `CitationList`, `useDocumentStore` |
| 11 | Deletion lifecycle + sweeper | Soft-delete metadata, hard-delete chunks+object, worker retry |
| 12 | Evaluation + security verification + reports | ≥15 docs, ≥50 queries, P@5/R@5/MRR, citation correctness, honest limitations |

---

## 8. Security verification (Phase 2 scope)

- **No client-supplied identity** — all routes use `getAuth(req)` (verified JWT).
- **No storage paths in responses** — `KnowledgeDocument` omits `storage_path`/`storage_filename`.
- **Signed URLs only** — `viewDocumentHandler` returns 120s signed URL (or local content route).
- **File validation from bytes** — magic bytes, not browser MIME; DOCX zip-bomb preflight.
- **Duplicate detection** — content hash (sha256) scoped to user + live statuses.
- **Deletion** — `deleting` status immediately excludes from retrieval; worker sweeper retries storage failures.
- **Prompt injection defence** — document context injected as labelled untrusted block in user turn (design; not yet implemented).
- **Worker uses service_role** — bypasses RLS for queue ops only; API never uses service_role.

---

## 9. Next steps

1. **Phase 3:** Implement extraction services + tests.
2. **Phase 4–5:** Chunking + embeddings + persistence.
3. **Phase 6:** Worker + scheduler integration with `worker.ts`.
4. **Phase 7–9:** Retrieval + RAG + citations.
5. **Phase 10:** Frontend Knowledge Base panel + chat integration.
6. **Phase 11:** Deletion sweeper.
7. **Phase 12:** Run evaluation script (≥15 docs, ≥50 queries) → `DOCUMENT_RAG_EVALUATION_REPORT.md`.
8. Final gates: 294 baseline + new tests pass; server/client typecheck/build pass; both reports complete.

---

## 10. Files changed / added in Phase 2

**Modified (6):**
- `server/package.json` (+ `multer`, `pdfjs-dist`, `mammoth`, `jszip`, `@types/multer`)
- `server/package-lock.json`
- `server/src/app.ts` (mount `/api/documents`)
- `server/tests/helpers/fakeSupabase.ts` (documents, chunks, jobs, RPCs, storage fake)
- `shared/schemas.ts` (chat + document schemas)
- `shared/types.ts` (chat + document types)

**Added (21+):**
- `supabase/migrations/0011_documents_schema.sql`
- `supabase/migrations/0012_documents_storage.sql`
- `server/src/config/documents.config.ts`
- `server/src/services/documents/errors.ts`
- `server/src/services/documents/validation.ts`
- `server/src/services/documents/document.service.ts`
- `server/src/services/storage/storage.provider.ts`
- `server/src/services/storage/supabase.storage.ts`
- `server/src/services/storage/local.storage.ts`
- `server/src/services/storage/index.ts`
- `server/src/middleware/upload.middleware.ts`
- `server/src/middleware/rate-limit.middleware.ts`
- `server/src/controllers/document.controller.ts`
- `server/src/routes/document.routes.ts`
- `MILESTONE_5_PLAN.md`

---

*Report generated after Phase 2 completion. All claims reflect implemented and tested code only. Phases 3–12 are planned but not yet executed.*