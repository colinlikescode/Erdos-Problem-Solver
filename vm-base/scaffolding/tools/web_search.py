#!/usr/bin/env python3
"""web_search.py - Firecrawl search with a GPT-5.5 (xhigh) digest layer.

Searches the web (Firecrawl /v2/search), scrapes the top results to markdown,
and has GPT-5.5 read them and answer the question with cited sources. The
digest keeps raw pages OUT of the calling agent's context - only the
distilled, grounded answer comes back. The digest LLM follows the fleet's
fallback order: codex-broker pool -> reserve -> OPENAI_API_KEY (llm_client.py).

Usage:
  web_search.py "query or question"                       search + digest
  web_search.py "query" --raw                             just titles/URLs/snippets (no scrape, no digest)
  web_search.py "query" --limit 8 --tbs qdr:m             recency filter (qdr:h/d/w/m/y)
  web_search.py "query" --category research               github | research | pdf (repeatable)
  web_search.py "query" --site docs.python.org            restrict to domains (repeatable)

Env: FIRECRAWL_API_KEY (required); RAILWAY_BROKER_URL/RAILWAY_BROKER_API_KEY
or OPENAI_API_KEY (required unless --raw).
Cost: 2 Firecrawl credits per 10 results; +1/page when scraping (digest mode).
"""
import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_client

FIRECRAWL_URL = "https://api.firecrawl.dev/v2/search"
PER_PAGE_CHARS = 12000   # cap per scraped page fed to the digest LLM
TOTAL_CHARS = 90000      # cap across all pages


def post_json(url: str, body: dict, headers: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def firecrawl_search(args) -> list:
    key = os.environ.get("FIRECRAWL_API_KEY", "").strip()
    if not key:
        sys.exit("web_search: FIRECRAWL_API_KEY not set; search unavailable.")
    body = {"query": args.query, "limit": args.limit, "sources": ["web"]}
    if args.tbs:
        body["tbs"] = args.tbs
    if args.category:
        body["categories"] = args.category
    if args.site:
        body["includeDomains"] = args.site
    if not args.raw:
        body["scrapeOptions"] = {"formats": ["markdown"], "onlyMainContent": True}
    out = post_json(FIRECRAWL_URL, body, {"Authorization": f"Bearer {key}"})
    if not out.get("success"):
        sys.exit(f"web_search: Firecrawl error: {json.dumps(out)[:400]}")
    return (out.get("data") or {}).get("web") or []


def digest(question: str, results: list) -> str:
    total = 0
    chunks = []
    for i, r in enumerate(results, 1):
        md = (r.get("markdown") or r.get("description") or "")[:PER_PAGE_CHARS]
        total += len(md)
        if total > TOTAL_CHARS:
            break
        chunks.append(f"[source {i}] {r.get('title', '')}\nURL: {r.get('url', '')}\n{md}")
    prompt = (
        "You are a research assistant. Using ONLY the sources below, answer the "
        "question concisely (<= 300 words). Cite sources inline as [source N] "
        "and finish with a 'Sources:' list of the URLs you actually used. If "
        "the sources do not answer the question, say so plainly.\n\n"
        f"Question: {question}\n\n" + "\n\n---\n\n".join(chunks)
    )
    try:
        return llm_client.complete(prompt)
    except Exception as e:
        sys.exit(f"web_search: digest LLM failed ({e}); rerun with --raw.")


def main() -> None:
    p = argparse.ArgumentParser(description="Firecrawl search + GPT-5.5 digest.")
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=5)
    p.add_argument("--tbs", default="", help="recency: qdr:h/d/w/m/y")
    p.add_argument("--category", action="append", choices=["github", "research", "pdf"])
    p.add_argument("--site", action="append", help="restrict to domain (repeatable)")
    p.add_argument("--raw", action="store_true", help="skip scraping + digest; list results only")
    args = p.parse_args()

    results = firecrawl_search(args)
    if not results:
        print("No results.")
        return
    if args.raw:
        for r in results:
            print(f"- {r.get('title', '')}\n  {r.get('url', '')}\n  {r.get('description', '')}")
        return
    print(digest(args.query, results))


if __name__ == "__main__":
    main()
