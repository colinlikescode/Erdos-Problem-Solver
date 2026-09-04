---
name: web-search
description: Search the web and get full content from results
---

# web-search

Firecrawl search plus a GPT-5.5 digest. Needs `FIRECRAWL_API_KEY` in the
environment (the provisioner sets it; the digest LLM credentials are pre-wired
too). For papers and academic sources use `research-search` instead.

Search only when necessary. If the question is something you can reason out,
derive, or already know (standard math, your own code, general programming), do
that instead; searching costs credits and time. Reach for this when you need a
specific external fact: a math package's API, a named concept or theorem you
don't know, current documentation, an exact error message.

## Default: ask a question, get a cited answer

```bash
web-search "what does the galois python package's GF class do?"
```

It searches Firecrawl, scrapes the top results to markdown, and has GPT-5.5
read them and return a short answer with cited source URLs. The raw pages never
enter your context, only the distilled answer. Phrase the query as the actual
question you want answered.

## Options

```bash
web-search "query" --raw                 # titles/URLs/snippets only (no scrape, no digest)
web-search "query" --limit 8             # more results (max 20)
web-search "query" --tbs qdr:m           # recency: qdr:h / d / w / m / y
web-search "query" --category github     # github | research | pdf (repeatable)
web-search "query" --site docs.rs        # restrict to a domain (repeatable)
```

- Use `--raw` when you just want URLs to inspect yourself, then read a specific
  page via a `--site`-restricted digest or curl Firecrawl's scrape endpoint.
- `--site` maps to Firecrawl `includeDomains` (domains only, no protocol).

## Notes

- Cost: 2 Firecrawl credits per 10 results; digest mode adds 1 credit per
  scraped page. Keep `--limit` small (default 5).
- The digest answers strictly from the fetched sources and says so when they
  don't contain the answer. Treat that as "search differently or think it
  through", not as a reason to re-run the same search.
- Store durable findings in `notebook.md`. Don't rely on your context
  remembering a search.
