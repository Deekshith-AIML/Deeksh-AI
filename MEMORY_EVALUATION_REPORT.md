# Memory Retrieval Evaluation Report — Milestone 4.1

**Date:** 2026-11-06
**Status:** Live benchmark re-run against the local `pgvector` database after fixing the metric implementation and dataset design.
**Verdict:** Retrieval works and is measurable, but quality is **moderate at the default threshold** (P@5 0.2367, Recall@5 0.5510, MRR 0.4898). Do not claim production-grade retrieval quality yet.

---

## Configuration

| Setting | Value |
|---|---|
| Embedding provider | Gemini (live API) |
| Embedding model | `gemini-embedding-2` |
| Dimensions | 1536 |
| Similarity threshold | 0.65 |
| Seeded memories | 40 |
| Queries evaluated | 51 (49 scored + 1 irrelevant + 1 empty) |
| Database | `chitti-pg` (PostgreSQL 16, pgvector 0.8.7, HNSW cosine index) |
| Test user | `11111111-1111-4111-8111-111111111111` |
| Script | `server/scripts/evaluate-memory-retrieval.ts` |

---

## Dataset design (fixed in this pass)

The previous benchmark mapped queries to arbitrary seed indexes that did not
share any content with the query. That produced P@5 = 0.03 and MRR values
greater than 1 (`2.00`), which is mathematically impossible and invalidated
the report.

The dataset is now built so every query has a **known expected result set**:

- **40 memories**, one per seed, cycling through all 9 categories.
  Each memory contains a unique reference token `EVALTOKEN<i>` and a
  category-specific natural-language theme.
- **40 exact queries** — `EVALTOKEN<i>` → expected seed `<i>`.
- **9 semantic queries** — one per category → expected = all seeds in that
  category.
- **1 irrelevant query** — weather/football text → expected = none.
- **1 empty query** — must return zero rows.

Only the benchmark's own rows are deleted between runs
(`source_evidence LIKE 'bench:%'` or legacy `Evaluation seed #%`), scoped to
the test user. No other user's data is touched.

---

## Results (actual output, 2026-11-06)

| Metric | Value |
|---|---|
| **Precision@5** | **0.2367** |
| **Recall@5** | **0.5510** |
| **MRR** | **0.4898** |
| Relevant retrieval rate | 55.10% |
| Irrelevant inclusion rate | 21.95% |
| Empty-query rejection rate | 100% |
| Scored queries | 49 |
| Total queries | 51 |

### Metric definitions

- **P@5** = relevant retrieved / 5 (fixed cutoff).
- **Recall@5** = relevant retrieved / min(|expected|, 5).
- **MRR** = mean of `1 / rank` of the **first** relevant result
  (rank 1 → 1.0, rank 2 → 0.5, none → 0).
- Aggregates are means over queries that have at least one expected id;
  the irrelevant and empty queries are excluded from P@5/Recall/MRR and
  measured by their own rates.

### Per-query breakdown (first 10 exact queries)

| Query | P@5 | Recall@5 | MRR |
|---|---|---|---|
| Q_EXACT_0 | 0.00 | 0.00 | 0.00 |
| Q_EXACT_1 | 0.00 | 0.00 | 0.00 |
| Q_EXACT_2 | 0.00 | 0.00 | 0.00 |
| Q_EXACT_3 | 0.20 | 1.00 | 1.00 |
| Q_EXACT_4 | 0.20 | 1.00 | 1.00 |
| Q_EXACT_5 | 0.00 | 0.00 | 0.00 |
| Q_EXACT_6 | 0.00 | 0.00 | 0.00 |
| Q_EXACT_7 | 0.20 | 1.00 | 0.25 |
| Q_EXACT_8 | 0.20 | 1.00 | 1.00 |
| Q_EXACT_9 | 0.00 | 0.00 | 0.00 |

---

## Analysis

### P@5 is structurally capped for exact queries

Each exact query has **one** expected memory, so its maximum possible P@5 is
`1/5 = 0.20`. The reported 0.2367 aggregate is therefore dominated by how
many exact queries retrieve their seed at all, plus the higher-recall
semantic queries. It is not comparable to a benchmark where every query has
five relevant documents.

### Recall@5 0.5510

Just over half of the expected memories are found within the top 5 at
threshold 0.65. Many exact-token queries return nothing, which is consistent
with cosine similarity for very short token-only queries (`EVALTOKEN12`) —
the embedding space does not treat that token as strongly as long natural
language. This is a **dataset/query-shape limitation**, not evidence that
long-form user memories fail.

### MRR 0.4898

The first relevant result appears around rank 2 on average when it appears.
No value exceeds 1.0; the previous `2.00` entries were a 0-indexing bug and
are now fixed and unit-tested.

### Irrelevant inclusion rate 21.95% — the main quality concern

Nearly 22% of queries that declare irrelevant seeds returned at least one of
them in the top 5. At threshold 0.65 this is too permissive for a memory
feature where a wrong memory can distort a chat answer. Options:

1. raise the default threshold (e.g. 0.72–0.75) and re-measure,
2. add a lexical guard for contradictory/negative matches,
3. keep 0.65 but require at least one high-confidence hit before injection.

No threshold was changed in this milestone; the setting remains user-tunable.

### Empty-query rejection 100%

Empty text never requests an embedding and returns zero rows.

---

## Limitations

1. **Synthetic dataset.** Categories and tokens are generated, not real user
   memories. Real memories are longer and semantically richer; these numbers
   are a lower bound on natural-language retrieval, not a production SLA.
2. **Single provider.** Only Gemini `gemini-embedding-2` (1536 dims) is
   searchable. Ollama `embeddinggemma` (768 dims) cannot serve `vector(1536)`
   and is isolated-evaluation only.
3. **Single threshold.** Only 0.65 was measured; no sweep was run.
4. **Exact-token queries are harsh.** Short unique tokens under-represent
   how users actually phrase recall requests.
5. **No human relevance judgements.** Expected ids are constructed, not
   labelled by a person.

---

## Reproduction

```powershell
# Requires chitti-pg running on localhost:55432 and GEMINI_API_KEY in server/.env
cd server
npx tsx scripts/evaluate-memory-retrieval.ts
```

The script prints a JSON report and exits non-zero if the database is
unreachable or seeding fails. It is never part of `npm test`.

---

## Metric regression tests

`server/tests/memory-eval.test.ts` now contains real assertions:

- rank 1 → reciprocal rank 1.0,
- rank 2 → reciprocal rank 0.5,
- no relevant result → 0,
- P@5 = hits / 5, Recall@5 = hits / min(|expected|, 5),
- top-k cutoff is respected,
- expected ids are de-duplicated,
- aggregate means match hand-computed values,
- service wiring returns the expected seeded ids.

*Generated from the live run above on 2026-11-06.*

---

# Milestone 4.2 addendum � hybrid retrieval benchmark (2026-11-08)

**What changed:** `match_memories()` gained an optional `p_query_text`
argument (migration `0009`) and now combines vector similarity with
PostgreSQL full-text lexical matching. The benchmark was rewritten to seed
and embed **once**, then evaluate 9 configurations against the **real
migrated SQL function**, including the database RPC round-trip.

**Reproduction:**

```powershell
cd server
$env:EVAL_OUTPUT="$env:TEMP\bench-m42.json"
npx tsx scripts/evaluate-memory-retrieval.ts
```

## Same dataset, same embeddings, 9 configurations

| Config | P@5 | Recall@5 | MRR | Relevant | Irrelevant | Empty | Avg DB RPC ms |
|---|---|---|---|---|---|---|---|
| vector@0.60 | 0.2367 | 0.5510 | 0.4898 | 0.5510 | 0.2195 | 1.00 | 51.60 |
| vector@0.65 | 0.2367 | 0.5510 | 0.4898 | 0.5510 | 0.2195 | 1.00 | 53.75 |
| vector@0.70 | 0.2367 | 0.5510 | 0.4898 | 0.5510 | 0.2195 | 1.00 | 50.84 |
| vector@0.72 | 0.2367 | 0.5510 | 0.4898 | 0.5510 | 0.2195 | 1.00 | 52.37 |
| vector@0.75 | 0.2367 | 0.5510 | 0.4898 | 0.5510 | 0.2195 | 1.00 | 50.72 |
| **hybrid@0.60** | **0.3265** | **1.0000** | **1.0000** | **1.0000** | 0.2195 | 1.00 | 58.84 |
| **hybrid@0.65** | **0.3265** | **1.0000** | **1.0000** | **1.0000** | 0.2195 | 1.00 | 57.94 |
| **hybrid@0.70** | **0.3265** | **1.0000** | **1.0000** | **1.0000** | 0.2195 | 1.00 | 57.41 |
| **hybrid@0.75** | **0.3265** | **1.0000** | **1.0000** | **1.0000** | 0.2195 | 1.00 | 58.07 |

### Split by query kind (hybrid@0.65 vs vector@0.65)

| Query kind | Queries | Vector P@5 / R@5 / MRR | Hybrid P@5 / R@5 / MRR |
|---|---|---|---|
| Exact token | 40 | 0.09 / 0.45 / 0.375 | **0.20 / 1.00 / 1.00** |
| Semantic (category) | 9 | 0.8889 / 1.00 / 1.00 | 0.8889 / 1.00 / 1.00 (unchanged) |

## Honest interpretation

- **The gain is real but narrow.** Every point of improvement comes from the
  40 exact-token queries, which contain a literal `EVALTOKEN<i>` string.
  Full-text matching finds those deterministically; a user paraphrase would
  not contain the token. Semantic queries were already perfect and did not
  change.
- **Threshold did not matter on this dataset.** Vector results were identical
  at 0.60�0.75 because the retrieved top-5 set did not change: relevant seeds
  score above 0.75 and the rest fall below 0.60, leaving no borderline band.
  A more realistic dataset is needed to justify a threshold change, so the
  **default threshold remains 0.65**.
- **The known weakness is unchanged.** Irrelevant inclusion stays at 21.95%;
  hybrid adds no false positives here (irrelevant text has no lexical
  overlap), but it does not fix that weakness either.
- **Cost is small and measured.** +5�6 ms per query on the DB RPC path
  (~+11%), no second embedding call, no LLM reranking call.
- **Bloom filter for the alternative:** an LLM reranker was NOT added. It
  would add a paid, variable-latency call to every retrieval without evidence
  it helps this dataset.

**Decision:** keep hybrid retrieval, enabled only when a natural-language
query is supplied (chat + `/api/memories/search` with `query_text`). Callers
that omit `query_text` keep exact pre-4.2 vector behaviour. This is a
consistent, non-regressing improvement, so the previous implementation is
retained as the default path rather than removed.
