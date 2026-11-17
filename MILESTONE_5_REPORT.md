# DEEKSH AI — Milestone 5 Report
# Personal Knowledge Base & Retrieval-Augmented Generation

**Status:** M5 IMPLEMENTATION IN PROGRESS — Phases 2–11 implemented on `stabilization/m4.2` (HEAD `d9e9f29`) plus Corrective Patch 1 (PDF page provenance + test typecheck), Corrective Patch 2 (DOCX structure, bounded ZIP security, oversized-paragraph chunking), Corrective Patch 3 (document search API + citation viewer) and Corrective Patch 4 (pipeline reliability + security). Evaluation (Phase 12), live Supabase verification, and final acceptance are **not complete**. This report is not a completion claim.

**Date:** 2026-11-10  
**Branch:** `stabilization/m4.2`  
**Baseline preserved:** `8c61e5b` (M4.2 checkpoint `ba180ae`)

---

## 0. Corrective Patch 1 — PDF page provenance + test typecheck

### Root causes

1. **Wrong PDF page numbers.** `pdf.extractor.ts` extracted pages in a loop but then built paragraphs with literal `pageStart: 1` / `pageEnd: 1`. The loop index was discarded, so every paragraph from every page claimed page 1. The existing fixture only asserted page 1, which is why the defect passed the suite.
2. **Test TypeScript project was not clean.** `server/tsconfig.test.json` enables `strict` + `noUncheckedIndexedAccess`. Direct `array[0]` accesses in `retrieval.test.ts`, `chunk-embedding.test.ts`, `chunking.test.ts`, and `citation.test.ts` assumed an element exists. These were test-only type errors; no production behaviour was wrong.

### Files changed

| File | Change |
|---|---|
| `server/src/services/documents/extraction/pdf.extractor.ts` | Reconstructs positioned lines → paragraphs per page, assigns the real page number to every paragraph, conservatively stitches true cross-page continuations, counts `pages_with_text` honestly. |
| `server/src/services/documents/extraction/normalize.ts` | Validates and propagates page ranges: one-sided range becomes that page, inverted range is ordered, non-positive/non-finite values become `null`, and no page is fabricated. |
| `server/tests/extraction-integration.test.ts` | Strengthened PDF fixtures with uniquely identifiable page text; added multi-page provenance, cross-page continuation, and empty-page regression tests. |
| `server/tests/retrieval.test.ts` | Replaced unchecked `results[0]` / `fakeDb.documents[0]` accesses with explicit guards. |
| `server/tests/chunking.test.ts` | Built provenance inline (no possibly-undefined `provs[i]`), added first-chunk guards, preserved all assertions. |
| `server/tests/chunk-embedding.test.ts` | Added persisted-chunk and updated-row guards. |
| `server/tests/citation.test.ts` | Asserts the complete ordered marker list instead of unchecked indices. |
| `MILESTONE_5_REPORT.md` | This section. |

### PDF provenance behaviour

- Every paragraph carries the actual page it was extracted from (`pageStart === pageEnd` for single-page content).
- Pages are processed in order 1..N; document order is preserved in `paragraphs[]` and `totalText`.
- A paragraph is stitched across a page break only when the previous paragraph is unfinished (no terminal punctuation) **and** the next page starts in lowercase or continuation punctuation. Headings are never merged.
- A stitched paragraph keeps `pageStart` from the page where it began and `pageEnd` from the page where it finished (tested as 1 → 2).
- Empty pages produce no paragraphs. They never inherit a neighbouring page number.
- DOCX and TXT still carry `pageStart = null` / `pageEnd = null`; no page numbers are invented for formats without pages.
- PDF paragraph grouping remains heuristic (baseline grouping + vertical gaps). It is not OCR and does not claim perfect layout recovery.

### New / strengthened regression tests

| Test | Assertion |
|---|---|
| `extracts PDF text with page tracking` | Single-page paragraph has `pageStart = 1`, `pageEnd = 1`. |
| `preserves actual page provenance for a multi-page PDF` | `PROJECT INTRODUCTION` → 1/1; `TECHNICAL REQUIREMENTS` → 2/2; order preserved; page-2 citation is never page 1; body paragraphs inherit their page. |
| `keeps page ranges for paragraphs that continue across pages` | Stitched text contains both fragments; `pageStart = 1`, `pageEnd = 2`; only one merged paragraph exists. |
| `handles empty PDF pages without inventing provenance` | 3-page PDF with empty page 2 → no paragraph claims page 2; page-3 text claims 3/3; `pages_with_text = 2`. |

### Verification results (actual)

| Gate | Command | Result |
|---|---|---|
| Server tests | `npm test --prefix server` | **26 files, 335 tests passed** (294 baseline preserved, +41 M5 tests) |
| Server typecheck | `npm run typecheck --prefix server` | **Clean** (`tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json`) |
| Server test typecheck (standalone) | `server\node_modules\.bin\tsc.cmd --noEmit -p server/tsconfig.test.json` | **Clean (exit 0)**. Note: `npx tsc ...` from the repo root resolves a placeholder global `tsc` 10.9.2 because TypeScript is installed per-package, not at the root; use the local binary or the server script. |
| Client typecheck | `npm run typecheck --prefix client` | **Clean** |
| Server build | `npm run build:server` | **Success** |
| Client build | `npm run build:client` | **Success** (optimized build, 6/6 static pages) |

### Remaining M5 limitations after this patch

- **Phase 12 evaluation is not started.** No ≥15-document / ≥50-query corpus, no `DOCUMENT_RAG_EVALUATION_REPORT.md`.
- **Live Supabase ingestion is blocked** (`SUPABASE_SERVICE_ROLE_KEY` absent); storage policies/signed URLs are not live-verified.
- **DOCX headings and tables were not extracted** at the time of Patch 1 (`mammoth.extractRawText`). **Resolved in Patch 2 — see §0.1.**
- **PDF text reconstruction is heuristic** and conservative continuation stitching may miss some real continuations (or, rarely, merge a lowercase-start heading).
- **No OCR**; scanned PDFs still fail with `SCANNED_PDF_REQUIRES_OCR`.
- **`/api/documents/search` is not implemented**, and the client has no `/documents` route for citation links.
- **Oversized single paragraphs were not hard-split** in chunking at the time of Patch 1. **Resolved in Patch 2 — see §0.1.**
- **No malware scanner**; not claimed.
- **Upload/validation/worker/scheduler tests are still missing**; worker reliability rests on SQL-level verification.

---

## 0.1 Corrective Patch 2 — DOCX structure, ZIP security, oversized-paragraph chunking

### Root causes

1. **DOCX structure was discarded.** The extractor called `mammoth.extractRawText`, which returns a flat string. Headings, heading depth, tables, rows, cells and section paths were all lost, so DOCX citations could not point at a section or structurally meaningful block.
2. **ZIP preflight relied on JSZip.** Upload validation loaded the archive with JSZip before inspecting sizes, so resource limits were applied *after* the library had parsed the container. Entry-count and per-entry limits were incomplete, traversal-safe names were not enforced, and required package parts were partially checked.
3. **Oversized paragraphs were never split.** `chunking.ts` contained `splitLongParagraph()` but never called it. The branch for an oversized paragraph was a comment-only no-op, so a single long paragraph could exceed `chunkTargetTokens` without bound. The overlap logic also sliced raw characters, which could start a chunk mid-word.

### Files changed

| File | Change |
|---|---|
| `server/src/services/documents/docx.zip.ts` | **New.** Bounded ZIP central-directory reader. Enforces single-disk only, rejects ZIP64, caps entry count / per-entry uncompressed size / total uncompressed size / compression ratio, rejects encrypted entries, unsupported methods, malformed central directories, unsafe paths and missing OOXML parts. Reads raw bytes only — no extraction to disk. |
| `server/src/services/documents/validation.ts` | `preflightDocx` now delegates to `inspectDocxZip`; the JSZip-based preflight and its partial checks were removed from the hot path. |
| `server/src/config/documents.config.ts` | Added `docxMaxEntryUncompressedBytes` (`DOCX_MAX_ENTRY_UNCOMPRESSED_BYTES`, default 50 MiB). |
| `server/src/services/documents/extraction/docx.extractor.ts` | Replaced raw-text extraction with `mammoth.convertToHtml` + a small deterministic HTML reader. Emits ordered heading / paragraph / table-row / list-item blocks with heading level, section path, table ordinal and row ordinal. |
| `server/src/services/documents/extraction/index.ts` | `RawParagraph` and `ParagraphProvenance` gained optional `blockType`, `headingLevel`, `tableIndex`, `tableRowIndex` (additive; PDF/TXT unchanged). |
| `server/src/services/documents/extraction/normalize.ts` | Propagates the new structural fields without altering existing behaviour. |
| `server/src/services/documents/chunking.ts` | Rewrote splitting/packing: sentence-first pieces, word fallback, character split for one huge token, section-bounded packing, controlled overlap that never exceeds the budget. |
| `server/tests/extraction-integration.test.ts` | Added DOCX heading hierarchy / section-path / table / multi-table / empty-section / malformed-package tests. |
| `server/tests/docx-security.test.ts` | **New.** 18 ZIP security tests. |
| `server/tests/chunking.test.ts` | Added 8 oversized-paragraph / overlap / provenance / multi-page tests. |
| `MILESTONE_5_REPORT.md` | This section. |

### DOCX structure extraction

- **Headings:** `h1`–`h6` become `blockType: 'heading'` blocks with `headingLevel` 1–6.
- **Section hierarchy:** a heading stack produces a full `sectionPath` such as `Project Plan > Goals > Metrics`. Leaving a level closes deeper sections; sibling headings do not leak into each other.
- **Paragraphs and lists:** `blockType: 'paragraph'` and `blockType: 'list-item'`, in document order.
- **Tables:** one `blockType: 'table-row'` block per row, cells joined with ` | `, plus zero-based `tableIndex` and `tableRowIndex`. Multiple tables are distinguished by ordinal.
- **Ordering:** blocks are emitted exactly in source order; headings, body text and tables interleave correctly.
- **Provenance:** every block carries `heading`, `sectionPath`, `index` and character offsets.
- **No page numbers:** DOCX `pageStart` / `pageEnd` are always `null`. Word has no stable PDF-style page model, so citations use heading/section/paragraph references instead. Page numbers are never invented.
- **Safe parsing:** Mammoth escapes document text. The internal reader understands only a fixed structural tag set; it ignores attributes, scripts, styles, links and images and never fetches or executes anything. No new dependency was added.

### ZIP security limits

| Guard | Behaviour |
|---|---|
| Entry count | `DOCX_MAX_ENTRIES` (default 2,000) → `DOCX_TOO_MANY_ENTRIES` |
| Total uncompressed size | `DOCX_MAX_UNCOMPRESSED_BYTES` (default 200 MiB) → `DOCX_TOO_LARGE` (413) |
| Individual entry size | `DOCX_MAX_ENTRY_UNCOMPRESSED_BYTES` (default 50 MiB) → `DOCX_ENTRY_TOO_LARGE` (413) |
| Compression ratio | `DOCX_MAX_COMPRESSION_RATIO` (default 100), applied above a 64 KiB floor → `DOCX_COMPRESSION_RATIO` |
| Encrypted entries | General-purpose flag bit 0 → `DOCX_ENCRYPTED` |
| Malformed central directory | Bad signature, out-of-bounds record, trailing records, truncated archive → `MALFORMED_FILE` |
| ZIP64 / multi-disk | Rejected by the bounded parser → `MALFORMED_FILE` |
| Unsupported method | Anything other than STORE (0) or DEFLATE (8) → `MALFORMED_FILE` |
| Path traversal | `..` segments, backslashes, absolute paths, drive letters, control characters and over-long names → `MALFORMED_FILE` |
| Package structure | Requires `[Content_Types].xml`, `_rels/.rels`, `word/document.xml` → `MALFORMED_FILE` |

**Patch 2 limitation (now resolved in Patch 4 — see 0.3):** the Patch 2 limits used declared sizes from the ZIP central directory. JSZip still inflates entries during Mammoth parsing, so an archive that lied about its declared sizes could expand further than the metadata claimed. Patch 4 adds *actual* bounded inflation during preflight. No malware scanning is performed anywhere.

### Chunking strategy

1. **Piece construction.** Each paragraph is split into provenance-carrying pieces:
   - one piece per sentence when possible;
   - a long sentence is packed at word boundaries;
   - a single token longer than the budget is split by characters (progress is guaranteed; the budget still holds).
2. **Section-bounded packing.** Pieces are accumulated in order until the token budget would be exceeded. A heading/section change flushes the open chunk and clears overlap, so unrelated sections are never blended.
3. **Controlled overlap.** Trailing pieces from the previous chunk are carried forward, up to `chunkOverlapTokens`, but only within the same section and only when they still fit the budget. Overlap can be dropped rather than exceed the budget.
4. **Provenance.** Every chunk keeps the document/user ids, sequential index, real page range (PDF), heading, section path, source paragraph range and character range. A split paragraph keeps its original paragraph id on every piece.
5. **Bounds.** `maxChunksPerDocument` is enforced; a single huge token cannot produce an oversized chunk.

### New / strengthened tests

| Area | Tests |
|---|---|
| DOCX structure | Heading hierarchy and levels (1/2/3/2), full section paths, ordered blocks, null pages, body inheritance, two tables with correct `tableIndex`/`tableRowIndex`, list items with section provenance, interleaved ordering, empty section handling, malformed package rejection. |
| ZIP security | Valid package, non-ZIP, truncated central directory, excessive entries, excessive total size, excessive entry size, compression-ratio abuse, encrypted entry, root and nested traversal, absolute path, missing required part, generic non-DOCX ZIP, multi-disk, unsupported compression method, no filesystem extraction, bounded entry metadata, exact central-directory enumeration. |
| Chunking | Sentence-boundary splitting, word-boundary splitting, one huge token, budget across mixed paragraphs, controlled overlap, section isolation, page/heading/paragraph provenance after splitting, multi-page PDF provenance. |

### Verification results (actual)

| Gate | Command | Result |
|---|---|---|
| Server tests | `npm test --prefix server` | **27 files, 364 tests passed** (335 Patch 1 baseline preserved, +29 Patch 2 tests) |
| Server typecheck | `npm run typecheck --prefix server` | **Clean, exit 0** (source + `tsconfig.test.json`) |
| Server test typecheck | `server\node_modules\.bin\tsc.cmd --noEmit -p server/tsconfig.test.json` | **Clean, exit 0** |
| Client typecheck | `npm run typecheck --prefix client` | **Clean, exit 0** |
| Server build | `npm run build:server` | **Success, exit 0** |
| Client build | `npm run build:client` | **Success, exit 0** (6/6 static pages) |

### Resolution of Patch 1 limitations

- DOCX headings and tables **are now extracted**, so DOCX section citations are available.
- Full bounded ZIP preflight limits **are now enforced** before Mammoth inflates the archive.
- Oversized single paragraphs **are now actually split** and cannot exceed the token budget.
- Still open: Phase 12 evaluation, live Supabase verification, `/api/documents/search`, the client `/documents` route, upload/validation and worker/scheduler tests, OCR and malware scanning (neither exists).

---

## 0.2 Corrective Patch 3 - document search API + citation viewer

### Root causes

- The client already called `POST /api/documents/search`, but the backend route did not exist, so every Knowledge Base semantic search failed.
- Citation chips linked to `/documents/{id}/view`, a frontend route that did not exist.
- The existing `/api/documents/:id/view` URL is short-lived (120 s) and, in local-storage mode, points at the authenticated `/content` route. Opening either URL directly in a new tab loses the bearer token for the local adapter.
- `searchDocumentChunks()` treated an RPC failure as an empty result set, which would make a database outage look like "no matches" on an explicit search surface.

### Search endpoint

`POST /api/documents/search` (declared before `/:id`):

```json
{
  "query": "string, 1-2000 chars, required",
  "document_ids": ["uuid", "..."],
  "threshold": 0.5,
  "max_results": 8
}
```

- `document_ids`: optional, max 20 UUIDs.
- `threshold`: optional number in `[0, 1]`; defaults to `DOC_RETRIEVAL_THRESHOLD`.
- `max_results`: optional integer in `[1, 50]`; defaults to `DOC_RETRIEVAL_TOP_K`, clamped to 50 by the service.

Response (`DocumentSearchResponse`):

```json
{
  "chunks": [
    {
      "chunk_id": "uuid",
      "document_id": "uuid",
      "filename": "resume.pdf",
      "chunk_index": 0,
      "page_start": 4,
      "page_end": 4,
      "heading": "Skills",
      "section_path": "2 > Skills",
      "similarity": 0.87,
      "preview": "bounded excerpt (max 400 chars)…"
    }
  ],
  "count": 1
}
```

### Retrieval integration

- Authentication comes only from `getAuth(req)`; no identity is read from the body or query string.
- Explicit `document_ids` are checked with `assertSearchableDocumentScope()` before embedding:
  - missing and foreign ids both return `404 DOCUMENT_NOT_FOUND` (no existence oracle);
  - `deleting`/`deleted` ids return `404`;
  - non-ready ids return `409 DOCUMENT_NOT_SEARCHABLE`.
- The query is embedded once via `embed(query, { role: 'query' })`.
- Retrieval uses the existing `searchDocumentChunks()` service and the existing `match_document_chunks` RPC. No vector SQL was duplicated in the controller.
- The RPC remains authoritative for ownership, `status = 'ready'`, non-null embeddings, optional document scope, threshold and result limits. The handler additionally drops any row whose `user_id` is not the caller.
- `throwOnError` was added to the retrieval service. Explicit search returns `503 DOCUMENT_SEARCH_UNAVAILABLE` on RPC failure instead of a misleading empty list. Chat retrieval keeps its existing non-fatal behaviour.
- Embedding-provider failures return `503 DOCUMENT_SEARCH_EMBEDDING_FAILED`; raw provider messages are not returned.
- Both routes are per-user rate limited (`searchRateLimiter`, default 60/min).

### Citation navigation and viewer

- `ChatBubble` now builds `/documents/{id}?page=…&chunk=…&heading=…` through the shared pure helper `shared/citation-link.ts`.
- The new App Router page `client/src/app/documents/[id]/page.tsx` parses query parameters defensively and renders the viewer behind `AuthGate`.
- The viewer (`client/src/components/documents/DocumentViewer.tsx`) fetches:
  1. `GET /api/documents/:id` for real metadata,
  2. `GET /api/documents/:id/view` for ownership/status verification,
  3. `GET /api/documents/:id/chunks` for section/paragraph provenance,
  4. `GET /api/documents/:id/content` with the bearer token for the bytes.
- **PDF:** object URL is rendered in the browser PDF viewer with `#page=N` only when extraction recorded a real page. Unknown page metadata produces no fragment and an explicit notice. A cited page outside the known page count is reported, not clamped or invented.
- **DOCX:** no page numbers exist, so the viewer shows the cited heading/section and scrolls the matching extracted chunk into view. A missing chunk id falls back to heading matching, then to the document start with an explicit notice.
- **TXT:** the cited chunk is resolved by chunk id, and the viewer displays the 1-based paragraph range, computed line range and highlighted excerpt (full text is expandable with the cited range marked).
- **Security:** all reads go through authenticated backend routes. No storage path, bucket URL or public URL is constructed by the client. Deleted, processing, unknown and foreign documents are rejected by `/view` before bytes are read; old citations to a deleted document return 404.
- The Knowledge Base panel now calls the real semantic search endpoint, shows grouped results by document, page/section references, similarity and excerpts, and supports loading, error, empty, selection-scoped search and "Open source" actions. The existing document list, upload, retry, delete and viewer actions remain functional.
- The local-storage/signed-URL expiry issue is avoided because the viewer streams bytes through `/content` with the bearer token; signed-URL expiry is therefore not part of the viewer path. Supabase storage remains private and short-lived for `/view`.

### New / strengthened tests

| Area | Tests |
|---|---|
| Search API | Valid owned result + provenance/preview bounds, invalid query/Zod cases (empty, too long, bad limits, bad threshold, bad/too many ids), missing auth, cross-user selection, empty result set, embedding-provider failure, RPC/database failure, deleted exclusion, unprocessed exclusion, explicit ready-document scoping, explicit unprocessed/deleted rejection, `max_results` bound. |
| Citation/viewer API | Owner view link (extension, page count, 120 s TTL, no storage-path field), unknown/non-UUID citation ids, cross-user document, deleted document via old citation, processing document, private `/content` bytes only for the owner with `Cache-Control: private, no-store`. |
| Citation navigation helpers | Real PDF page and `#page=N`, DOCX heading with no page, TXT chunk id, missing page never becomes page 1, invalid/non-positive page rejection, query-parameter parsing, no public/storage URL. |

### Verification results (actual)

| Gate | Command | Result |
|---|---|---|
| Server tests | `npm test --prefix server` | **29 files, 388 tests passed** (364 baseline preserved, +24 Patch 3 tests) |
| Server typecheck | `npm run typecheck --prefix server` | **Clean, exit 0** (source + `tsconfig.test.json`) |
| Server test typecheck | `server\node_modules\.bin\tsc.cmd --noEmit -p server/tsconfig.test.json` | **Clean, exit 0** |
| Client typecheck | `npm run typecheck --prefix client` | **Clean, exit 0** |
| Server build | `npm run build:server` | **Success, exit 0** |
| Client build | `npm run build:client` | **Success, exit 0**; `/documents/[id]` emitted as a dynamic route |

### Files changed in Patch 3

- `shared/citation-link.ts` (new)
- `server/src/controllers/document.controller.ts`
- `server/src/routes/document.routes.ts`
- `server/src/services/documents/retrieval.service.ts`
- `server/tests/helpers/fakeSupabase.ts` (RPC outage injection hook)
- `server/tests/document-search.test.ts` (new)
- `server/tests/citation-link.test.ts` (new)
- `client/src/app/documents/[id]/page.tsx` (new)
- `client/src/components/documents/DocumentViewer.tsx` (new)
- `client/src/components/documents/KnowledgeBasePanel.tsx`
- `client/src/components/chat/ChatBubble.tsx`
- `client/src/store/useDocumentStore.ts`
- `MILESTONE_5_REPORT.md`

### Remaining limitations after Patch 3

- M5 is **not** declared complete; Phase 12 evaluation has not started.
- Live Supabase ingestion/RLS/storage still cannot be verified locally (`SUPABASE_SERVICE_ROLE_KEY` absent); the API tests use the in-memory fake.
- No OCR: scanned PDFs still fail with `SCANNED_PDF_REQUIRES_OCR`.
- No malware scanning; no such claim is made.
- Search results carry page/section provenance directly and preserve paragraph provenance through `chunk_id`; the viewer resolves paragraph/line ranges from the authenticated chunk endpoint. The existing `DocumentSearchHit` contract was not expanded.
- DOCX has no native in-browser renderer here: the viewer shows the extracted section and provides an authenticated "Open original"/"Download" action. It never invents a page number.
- The viewer streams the whole object through `/content` (subject to the existing 25 MiB upload cap); no byte-range streaming was added.

---

## 0.3 Corrective Patch 4 — pipeline reliability and security

### Root causes

- **DOCX preflight trusted attacker-controlled metadata.** Patch 2 enforced limits from the ZIP central directory but never inflated entries, so an archive that declared a small uncompressed size and then inflated to a much larger payload could pass preflight.
- **No dedicated regression coverage** for upload validation, worker reliability or the deletion lifecycle. Phases 3–11 exercised these paths indirectly but not adversarially.
- **Compressed-data offset assumption** was unsafe: reading from `localHeaderOffset + 30` ignores per-entry local name/extra lengths.

### Actual bounded DOCX decompression

`server/src/services/documents/docx.zip.ts` now inflates every DEFLATE entry during preflight under a hard output cap (`inflateRawSync(..., { maxOutputLength })`). A lying archive that inflates beyond the cap is rejected with `DOCX_TOO_LARGE`; corrupt streams are rejected with `MALFORMED_FILE`. The compressed payload is located from the local header's own name/extra lengths (not a fixed `+30`). No new dependency was introduced — this uses Node's built-in `node:zlib`, which the project already ships with.

Enforced during inspection:

| Guard | Behaviour |
|---|---|
| Actual per-entry output | `maxOutputLength = min(docxMaxEntryUncompressedBytes, remaining total budget)` |
| Actual total output | `docxMaxUncompressedBytes` across all entries |
| Declared per-entry / total | Cheap first line before inflation → `DOCX_ENTRY_TOO_LARGE` / `DOCX_TOO_LARGE` |
| Compression ratio | Above a 64 KiB floor → `DOCX_COMPRESSION_RATIO` |
| Wall-clock budget | `docxInspectionTimeoutMs` (default 5000 ms, `DOCX_INSPECTION_TIMEOUT_MS`) → `DOCX_INSPECTION_TIMEOUT` |
| Entry count | `docxMaxEntries` → `DOCX_TOO_MANY_ENTRIES` |
| Malformed / truncated / corrupt | `MALFORMED_FILE` |
| Encrypted / ZIP64 / multi-disk / unsupported method | `DOCX_ENCRYPTED` / `MALFORMED_FILE` |
| Path traversal / absolute / control chars | `MALFORMED_FILE` |

Decompression stays entirely in memory; nothing is extracted to disk. Peak memory is bounded by the per-entry cap plus the (already capped) upload bytes.

### Upload validation tests

`server/tests/upload-validation.test.ts` (18 tests) covers: valid PDF/DOCX/TXT; unsupported extension; `.pdf`/`.docx` filenames with mismatched magic bytes; oversized and empty files; duplicate content; filename normalisation; path traversal (basename only); storage write failure; DB insertion failure; job-creation rollback; orphan cleanup; cross-user `getOwnedRow`. All storage is an in-memory fake — no real bucket is touched.

### Worker reliability tests

`server/tests/document-worker.test.ts` (13 tests) covers: successful processing to `ready` with persisted chunks/embeddings; atomic concurrent claiming (one winner); idempotent duplicate delivery; stale-claim recovery and restart; exhausted stale claims; transient storage retry; retry exhaustion; embedding-provider failure; partial chunk-insert failure; DB read failure; deleted-document exclusion; mismatched-owner rejection; deletion sweeper. The suite explicitly asserts a document is **never** `ready` without chunks and that failed attempts leave zero partial embeddings.

### Deletion lifecycle tests

`server/tests/document-deletion.test.ts` (7 tests) verifies: owner deletion removes chunks, jobs and the storage object; the document disappears from retrieval, explicit scope checks, citation view and content routes; foreign users get `404` and nothing is mutated; repeated deletion is idempotent (storage removed once); a failed storage delete leaves status `deleting` with `deletion_attempts`/`deletion_error` and the sweeper recovers it; other users' documents and unrelated memories are untouched.

### Security review (Patch 4)

| Check | Result |
|---|---|
| Malformed uploads | Rejected by magic bytes + structure; covered by tests |
| ZIP bombs | Bounded by actual inflate output caps (not declared metadata) |
| Unbounded memory | `maxOutputLength` + per-entry/total caps + upload cap |
| Cross-user storage access | Server-generated `{userId}/{docId}/{uuid}.ext` paths; `assertSafeObjectPath`; user-scoped client |
| Cross-user retrieval | `match_document_chunks` filters `p_user_id`; explicit scope returns `404` |
| Unauthorized deletion | `deleteDocument` calls `getOwnedRow` first |
| Citation after deletion | `getDocumentViewLink` / `readDocumentBytes` return `404` |
| Temporary-file cleanup | Nothing is written to disk (in-memory only) |
| Sensitive content in logs | Only typed error messages / job ids; `DocumentError` never includes content or paths |

**No OCR and no malware scanning exist.** Scanned PDFs still fail with `SCANNED_PDF_REQUIRES_OCR`. The report makes no anti-malware claim.

### Verification results (actual)

| Gate | Command | Result |
|---|---|---|
| Server tests | `npm test --prefix server` | **33 files, 433 tests passed** (388 Patch 3 baseline preserved, +45 Patch 4 tests) |
| Server typecheck | `npm run typecheck --prefix server` | **Clean, exit 0** (source + `tsconfig.test.json`) |
| Server test typecheck | `server\node_modules\.bin\tsc.cmd --noEmit -p server/tsconfig.test.json` | **Clean, exit 0** |
| Client typecheck | `npm run typecheck --prefix client` | **Clean, exit 0** |
| Server build | `npm run build:server` | **Success, exit 0** |
| Client build | `npm run build:client` | **Success, exit 0**; `/documents/[id]` dynamic route emitted |

### Files changed in Patch 4

- `server/src/services/documents/docx.zip.ts` — actual bounded inflation, local-header offset fix, time budget
- `server/src/config/documents.config.ts` — `docxInspectionTimeoutMs`
- `server/tests/docx-inflation-security.test.ts` (new, 7 tests)
- `server/tests/upload-validation.test.ts` (new, 18 tests)
- `server/tests/document-worker.test.ts` (new, 13 tests)
- `server/tests/document-deletion.test.ts` (new, 7 tests)
- `MILESTONE_5_REPORT.md`

### Known limitations after Patch 4

- M5 Phase 12 deterministic evaluation is complete; the live Supabase/Gemini run remains blocked (see §0.4).
- Live Supabase ingestion/RLS/storage still cannot be verified locally (`SUPABASE_SERVICE_ROLE_KEY` absent).
- The DOCX inflation loop is synchronous; the time budget is checked between entries, so a single pathological entry is bounded by zlib's `maxOutputLength`, not interrupted mid-inflate.
- Worker DB `update` results are not individually checked after the claim; a silently failed terminal update is caught by the next sweep/retry rather than surfaced immediately.
- No OCR, no malware scanning, no byte-range streaming.

---

## 0.4 Phase 12 — document RAG evaluation

**Status: deterministic evaluation complete; live E2E blocked by missing configuration.**
Full details: `DOCUMENT_RAG_EVALUATION_REPORT.md`.

### Deliverables

| File | Purpose |
|---|---|
| `server/scripts/evaluate-document-rag.ts` | Evaluation CLI: `--self-check` (offline) and live mode (seeded upload → real worker → production retrieval → `chat()` → citation validation → cleanup) |
| `server/scripts/evaluation/document-rag-corpus.ts` | 20 deterministic synthetic documents: 7 PDF (`pdf-lib`), 6 DOCX (`docx`), 7 TXT |
| `server/scripts/evaluation/document-rag-queries.ts` | 72 fixed queries across 10 categories (58 scored, 14 safety/refusal) |
| `server/scripts/evaluation/document-rag-metrics.ts` | P@5/R@5/MRR aggregation, irrelevant inclusion, empty-query rejection, latency p50/p95, citation availability/integrity, refusal and unsupported-answer rates |
| `server/scripts/evaluation/document-rag-self-check.ts` | Fail-closed corpus/query integrity and anchor checks |
| `server/tests/document-rag-evaluation.test.ts` | 16 tests: dataset integrity, anchors through real extraction + chunking, provenance, metric math |
| `server/tests/document-rag-answer.test.ts` | 4 tests: untrusted context placement, tool/citation isolation, Gemini→Ollama equivalence |
| `server/tests/document-rag-edge-cases.test.ts` | 6 tests: scanned PDF, empty TXT, oversized TXT, zero chunks, signed-link TTL, deleted view |
| `server/package.json` | `eval:documents`, `eval:documents:self-check` scripts |

### Ground truth

Expected results are hand-authored unique content anchors, resolved to
persisted chunk ids from the seeded corpus (never from retrieval output). Page
correctness uses containment because existing chunking intentionally allows
page-spanning chunks; exact start-page rate is reported separately.

### Verified deterministically (actual)

- Self-check: `20 documents ({"pdf":7,"docx":6,"txt":7}); 72 queries (58 scored)`.
- Every anchor resolves through the real `extractDocument()` + `chunkDocument()`
  pipeline; every expected page/heading is satisfied.
- Full suite: **459 passed / 459, 36 files** (433 pre-existing preserved).
- Six gates clean: server tests, server typecheck (source + test), client
  typecheck, server build, client build.
- Mocked answer path: document context only in the user turn, system rules
  intact, only two fixed tools, invented citations dropped, fallback receives
  identical context, no credential in prompts.
- Edge cases: scanned PDF fails permanently with `SCANNED_PDF_REQUIRES_OCR`;
  whitespace TXT fails with `NO_EXTRACTABLE_TEXT`; oversized TXT is capped by
  `maxChunksPerDocument`; zero chunks are rejected; view links are 120s signed
  URLs; deleted documents cannot be viewed.

### Blocked (not claimed)

- Final live audit on 2026-11-10: `SUPABASE_SERVICE_ROLE_KEY`, `EVAL_USER_ID`
  and `EVAL_CONFIRM` are still missing (also no local Docker/Supabase stack
  and no Ollama configuration). Live upload → worker → retrieval → answer →
  deletion and cross-user isolation remain blocked.
- Live Gemini embeddings and live Gemini/Ollama answer quality: blocked.
- No P@5 / R@5 / MRR / citation-correctness / faithfulness score exists yet;
  the script writes `server/evaluation-results/document-rag-evaluation-blocked.json`
  with the exact blocked steps and exits 0.
- Static safety audit passed: dedicated-email-prefix guard, per-user/ID
  scoping, own-record cleanup, worker scope limited to seeded jobs, private
  bucket by migration, and RLS ownership rules. These remain code-level
  findings until a live run.

### Limitations

No OCR, no malware scanning, password-protected PDFs unsupported, signed-URL
expiry not simulated, semantic citation support not auto-judged.

### Decision

**M5 implementation-complete; not fully production-verified.** M6 has not been
started.

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
| **Validation** | `server/src/services/documents/validation.ts`, `server/src/services/documents/docx.zip.ts` | Extension allow-list, filename normalisation, **magic-byte checks** (PDF `%PDF-`+`%%EOF`, DOCX ZIP, TXT UTF-8/16/1252, no NUL, <1% controls). DOCX preflight is a bounded central-directory reader: entry count, per-entry and total uncompressed size, compression ratio, encryption, ZIP64/multi-disk, unsafe paths and required OOXML parts — all enforced before Mammoth inflates anything. |
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
| Full server suite | **36 files, 459 tests passed** |
| Baseline (M1–M4.2) | **433 tests preserved** |
| M5 tests (Phases 3–12 + Patches 1–4) | **all passing**, including 26 Phase 12 evaluation tests |
| Server typecheck (source + tests) | **Clean** |
| Client typecheck | **Clean** |
| Server build | **Clean** |
| Client build | **Clean** |

Detailed corrective-patch results are in §0–§0.4. Upload validation, the
document worker/scheduler and the deletion lifecycle now have dedicated tests
(Patches 3–4 and Phase 12).

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
| `DOCX_MAX_UNCOMPRESSED_BYTES` | `209715200` | Total ZIP bomb guard |
| `DOCX_MAX_ENTRY_UNCOMPRESSED_BYTES` | `52428800` | Per-entry ZIP guard |
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
| 7 | Upload/validation and worker/scheduler tests missing | Phase 2 and Phase 6 coverage is not automated | Fake Supabase is ready; add tests before final acceptance. |
| 8 | DOCX structure is extracted, but nested tables are flattened | Nested-table cell text is not reproduced | Documented; common single-level tables are covered. |
| 9 | `/api/documents/search` missing; no `/documents` client route | UI semantic search and citation links cannot fully resolve | Add route + client page before claiming end-to-end UI. |
| 10 | PDF grouping is heuristic | Some multi-column layouts / continuations may be imperfect | Documented; no OCR or layout-engine claim. |
| 11 | ZIP limits use declared central-directory sizes | A malicious archive that lies about sizes could inflate further | Bounded parser rejects malformed/ZIP64 structures; streaming decompression is future work. |

---

## 7. Remaining phases (roadmap)

| Phase | Deliverable | Status |
|---|---|---|
| 3 | PDF/DOCX/TXT extraction (`pdfjs-dist`, `mammoth`+`jszip`) | Implemented + tested; PDF provenance corrected in Patch 1; DOCX headings, sections and tables added in Patch 2 |
| 4 | Structure-aware chunking (headings, paragraphs, pages, tables) | Implemented + tested; oversized-paragraph splitting, word/char fallback and controlled overlap added in Patch 2 |
| 5 | Embeddings + chunk persistence (reusing `embed()`, 1536-dim lock, mocks) | Implemented + tested |
| 6 | Durable worker + scheduler (`document.worker.ts`, `document.scheduler.ts`) | Implemented; no dedicated tests yet |
| 7 | `match_document_chunks` RPC + retrieval service | Implemented + tested |
| 8 | RAG integration in `ai.service.chat()` | Implemented; prompt rules in place |
| 9 | Citation validation & `ChatResponse.sources[]` | Implemented + tested |
| 10 | Knowledge Base UI + chat citations | Panel + citation chips implemented; `/documents` route missing |
| 11 | Deletion lifecycle + sweeper | Implemented + tested |
| 12 | Evaluation + security verification + reports | **Not started** — ≥15 docs, ≥50 queries, P@5/R@5/MRR, citation correctness |

---

## 8. Security verification (Phase 2 scope)

- **No client-supplied identity** — all routes use `getAuth(req)` (verified JWT).
- **No storage paths in responses** — `KnowledgeDocument` omits `storage_path`/`storage_filename`.
- **Signed URLs only** — `viewDocumentHandler` returns 120s signed URL (or local content route).
- **File validation from bytes** — magic bytes, not browser MIME; DOCX uses a bounded ZIP central-directory preflight before inflating.
- **Duplicate detection** — content hash (sha256) scoped to user + live statuses.
- **Deletion** — `deleting` status immediately excludes from retrieval; worker sweeper retries storage failures.
- **Prompt injection defence** — document context is injected as a labelled `<document_context untrusted="true">` block in the user turn; system-prompt rules forbid document text from authorising tools, permissions, or credentials. Implemented in `ai.service.ts` + `system.prompt.ts` (unit-tested at the extraction/citation layer; no live adversarial evaluation yet).
- **Worker uses service_role** — bypasses RLS for queue ops only; API never uses service_role.

---

## 9. Next steps

1. **Phase 12:** build the evaluation corpus (≥15 documents, ≥50 queries) and produce `DOCUMENT_RAG_EVALUATION_REPORT.md` with honest metrics.
2. **Missing API/UI wiring:** `/api/documents/search` route and a client `/documents` route for citation links.
3. **Coverage:** add upload/validation and worker/scheduler tests.
4. **Live verification:** Supabase Storage policies and ingestion once `SUPABASE_SERVICE_ROLE_KEY` is available.
5. **Final gates:** full suite, server/client typecheck, server/client build, then finalize both reports. M5 is not complete until these pass and the evaluation is reported.

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

*Report updated after Corrective Patch 4 (2026-11-10). All claims reflect implemented and verified code only. M5 remains in progress: Phase 12 evaluation and final acceptance are outstanding. No OCR or malware scanning is claimed.*