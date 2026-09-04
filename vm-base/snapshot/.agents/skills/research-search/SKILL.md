---
name: research-search
description: Search papers, read paper passages, find related work, and search across related GitHub repos
---

# research-search

Firecrawl's research index plus a GPT-5.5 digest. Needs `FIRECRAWL_API_KEY` in
the environment (the provisioner sets it; the digest LLM credentials are
pre-wired too).

Search only when necessary. Literature is for facts outside your head: is this
result already known, what constructions exist for order N, what does that
named theorem state. If you can derive it, derive it.

One command, five subcommands.

## 1. Find papers

```bash
research-search papers "<your problem area> construction survey" --k 10
```

Prints ranked ids, titles and abstract snippets. Filters: `--category cs.LG`,
`--author Kotsireas` (repeatable), `--from 2020-01-01`, `--to 2026-01-01`.

## 2. Read a paper by asking it a question

```bash
research-search read arxiv:2411.18897 "which orders below 1000 remain open?" --k 6
```

Retrieves the top full-text passages that answer the question and has GPT-5.5
digest them into a short cited answer. The raw paper never enters your
context. Use this to verify a paper actually contains a method, bound or
result before relying on it. `--raw` prints the passages instead.

## 3. Inspect metadata

```bash
research-search paper arxiv:1706.03762
```

## 4. Walk the citation graph

```bash
research-search similar arxiv:1809.05253 --intent "open cases in <your problem area>" --mode similar
```

`--mode similar` (co-citation neighborhood), `citers` (papers citing the seed),
or `references` (papers the seed cites). Good for turning one strong paper into
the whole relevant literature.

## 5. Search GitHub

```bash
research-search github "<your problem area> search implementation" --k 10
```

Issues, PRs, discussions and READMEs: implementation notes, bugs, prior art
(existing constructions in SageMath or other math libraries, for instance).

## Workflow and rules

- Typical loop: `papers`, pick one or two strong seeds, `read` to verify the
  claims, `similar --mode citers` to find what came after, `github` for code.
- Log every relevant paper (id plus a one-line takeaway) in `notebook.md` so
  the load-bearing facts survive compaction.
- A claim from a paper is still unverified math here until it passes the
  answer checker or Lean (AGENTS.md section 5). Cite it in notes, but never put
  it in `verified_math/` on the paper's authority alone.
- For general web and docs lookups use `web-search` instead.
