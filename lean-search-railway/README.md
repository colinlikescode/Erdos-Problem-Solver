# lean-search

Self-hosted natural-language search over Mathlib 4, a rebuild of LeanSearch on
the stack we already run. The VM `lean-search` skill calls this service; the
agent never talks to an external search site. TypeScript, built with `tsc`,
deployed on Railway.

## Pipeline

```
query -> GPT-5.5 (xhigh) augment -> Gemini embeddings-2 (RETRIEVAL_QUERY)
      -> Chroma Cloud top-50 (cosine) -> GPT-5.5 (xhigh) listwise rerank -> top-k
```

- Corpus: `FrenzyMath/lsv2-mathlib-v4.28.0-rc1-jsonl` (310,579 pre-informalized
  Mathlib declarations).
- Passage template (this matters): we embed the paper's kind-aware structured
  passage - `Kind / Name / Signature / Value(non-theorems) / Description` - not the
  raw `informal_description`. See `src/passage.ts`.
- Embeddings: `gemini-embedding-2`, asymmetric task types
  (`RETRIEVAL_DOCUMENT` for the corpus, `RETRIEVAL_QUERY` for queries).
- Augment + rerank LLM (always on): `gpt-5.5` at `xhigh` reasoning, using the
  fleet's provider chain - codex-broker pool, then reserve (decided broker-side), then
  `OPENAI_API_KEY`. The listwise rerank over the top 50 is the big quality
  jump (the paper's reranker is ~+10 nDCG). Kind-aware prompt.
- Store: Chroma Cloud, its own database (`CHROMA_DATABASE_2=lean-search`),
  collection `mathlib`, cosine space. Vectors are precomputed (no Chroma-side
  embedding function). Chroma calls go through a concurrency gate + backoff so
  parallel fleet load queues instead of tripping Chroma's rate limit.

## Layout

- `src/config.ts` - env-derived config.
- `src/passage.ts` - structured-passage + metadata builders.
- `src/gemini.ts` - embeddings-2 (embeddings only).
- `src/llm.ts` - GPT-5.5 augment + listwise rerank (broker, then OpenAI key).
- `src/chroma.ts` - Chroma Cloud collection + vector query (gated, retried).
- `src/server.ts` - HTTP (`/health`, `POST /search`).
- `src/main.ts` - entry point.
- `ingest.ts` - one-time corpus indexing (idempotent, resumable).
- `eval.ts` - golden-set quality eval (hit@1/3/10) against the deployed service.

## Endpoints

`POST /search` (Bearer `RAILWAY_LEAN_SEARCH_API_KEY`):

```bash
curl -X POST "$RAILWAY_LEAN_SEARCH_URL/search" -H "Authorization: Bearer $RAILWAY_LEAN_SEARCH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"the order of a group element divides the order of the group","k":10}'
```

Body: `{ query, k?=10, augment?=true, kind? }` (`kind` filters to
theorem/definition/instance/...). Returns `{ results: [{name, kind, signature,
informal_name, informal_description, module}] }`.

## Config (env)

- `RAILWAY_LEAN_SEARCH_API_KEY` - shared bearer secret the VMs use.
- `GEMINI_API_KEY` - embeddings-2.
- `RAILWAY_BROKER_URL` / `RAILWAY_BROKER_API_KEY` - GPT-5.5 via the codex-broker.
- `OPENAI_API_KEY` - GPT-5.5 last-resort tier.
- `CHROMA_API_KEY` / `CHROMA_TENANT` / `CHROMA_DATABASE_2` (=`lean-search`).
- Optional: `LEAN_EMBED_DIM` (1536), `LEAN_CANDIDATES` (50), `LEAN_RESULTS` (10),
  `LEAN_LLM_MODEL` (gpt-5.5), `LEAN_LLM_EFFORT` (xhigh).

## Build the index (one-time)

Download the corpus JSONL locally first (fast, no HF rate limits), then:

```bash
npm install && npm run build
node dist/ingest.js --file /tmp/lsv2/lsv2-mathlib-v4.28.0-rc1.jsonl   # full corpus
node dist/ingest.js --file ... --limit 500                              # smoke test first
node dist/ingest.js --file ... --offset 50000                          # resume after a stop
```

## Deploy (Railway, same project as codex-broker)

```bash
railway up --service lean-search
railway variables --service lean-search --set 'RAILWAY_LEAN_SEARCH_API_KEY=...' \
  --set 'GEMINI_API_KEY=...' --set 'RAILWAY_BROKER_URL=...' --set 'RAILWAY_BROKER_API_KEY=...' \
  --set 'OPENAI_API_KEY=...' --set 'CHROMA_API_KEY=...' --set 'CHROMA_TENANT=...' \
  --set 'CHROMA_DATABASE_2=lean-search'
```

## Quality eval

```bash
RAILWAY_LEAN_SEARCH_URL=... RAILWAY_LEAN_SEARCH_API_KEY=... npm run eval
```
