#!/usr/bin/env python3
"""research.py - Firecrawl Research Index client with a GPT-5.5 (xhigh) digest.

Purpose-built literature tooling (papers, passages, citation graph, GitHub
engineering history). `read` digests full-text passages through GPT-5.5 so raw
paper text stays out of the calling agent's context. The digest LLM follows
the fleet's fallback order: codex-broker pool -> reserve -> OPENAI_API_KEY
(llm_client.py).

Subcommands:
  papers  "query"  [--k 10] [--category cs.LG] [--author X] [--from Y-M-D] [--to Y-M-D]
      Search paper abstracts. Prints ranked ids + titles + abstract snippets.
  paper   <id>
      Inspect one paper's metadata (id like arxiv:1706.03762 or a paperId).
  read    <id> "question" [--k 6] [--raw]
      Top passages of the paper answering the question, digested into a
      concise cited answer (--raw prints the passages instead).
  similar <id> --intent "..." [--mode similar|citers|references] [--k 10]
      Expand from a seed paper through the citation graph.
  github  "query" [--k 10]
      Search GitHub issues/PRs/READMEs for implementation prior art.

Env: FIRECRAWL_API_KEY (required); RAILWAY_BROKER_URL/RAILWAY_BROKER_API_KEY
or OPENAI_API_KEY (required for the `read` digest).
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_client

BASE = "https://api.firecrawl.dev/v2/search/research"


def get(path: str, params: dict) -> dict:
    key = os.environ.get("FIRECRAWL_API_KEY", "").strip()
    if not key:
        sys.exit("research: FIRECRAWL_API_KEY not set; research index unavailable.")
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "", [])})
    req = urllib.request.Request(
        f"{BASE}{path}?{qs}", headers={"Authorization": f"Bearer {key}"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def unwrap(out, *keys):
    """Pull the result list out of {success, results|data: ...} envelopes."""
    node = out
    if isinstance(node, dict):
        node = node.get("results", node.get("data", node))
    for k in keys:
        if isinstance(node, dict) and k in node:
            node = node[k]
    return node if isinstance(node, list) else [node]


def show_papers(items) -> None:
    for p in items:
        if not isinstance(p, dict):
            print(f"- {p}")
            continue
        pid = p.get("primaryId") or p.get("paperId") or p.get("id") or "?"
        title = (p.get("title") or "").strip()
        abstract = (p.get("abstract") or "").strip().replace("\n", " ")
        print(f"- {pid}  {title}")
        if abstract:
            print(f"    {abstract[:300]}")


def digest_answer(question: str, passages: list) -> str:
    texts = []
    for i, p in enumerate(passages, 1):
        body = p.get("text") or p.get("passage") or p.get("content") or json.dumps(p)
        texts.append(f"[passage {i}] {body[:12000]}")
    prompt = (
        "You are a mathematics research assistant. Using ONLY the paper "
        "passages below, answer the question precisely (<= 250 words). Cite "
        "passages inline as [passage N]. If the passages do not answer the "
        "question, say so plainly.\n\n"
        f"Question: {question}\n\n" + "\n\n---\n\n".join(texts)
    )
    try:
        return llm_client.complete(prompt)
    except Exception as e:
        sys.exit(f"research: digest LLM failed ({e}); rerun `read` with --raw.")


def main() -> None:
    p = argparse.ArgumentParser(description="Firecrawl Research Index + GPT-5.5 digest.")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("papers", help="search paper abstracts")
    sp.add_argument("query")
    sp.add_argument("--k", type=int, default=10)
    sp.add_argument("--category", action="append")
    sp.add_argument("--author", action="append")
    sp.add_argument("--from", dest="date_from", default="")
    sp.add_argument("--to", dest="date_to", default="")

    ip = sub.add_parser("paper", help="inspect one paper's metadata")
    ip.add_argument("id")

    rp = sub.add_parser("read", help="answer a question from a paper's full text")
    rp.add_argument("id")
    rp.add_argument("question")
    rp.add_argument("--k", type=int, default=6)
    rp.add_argument("--raw", action="store_true", help="print passages; skip the digest")

    sim = sub.add_parser("similar", help="related papers from a seed")
    sim.add_argument("id")
    sim.add_argument("--intent", required=True)
    sim.add_argument("--mode", default="similar", choices=["similar", "citers", "references"])
    sim.add_argument("--k", type=int, default=10)

    gh = sub.add_parser("github", help="search GitHub engineering history")
    gh.add_argument("query")
    gh.add_argument("--k", type=int, default=10)

    args = p.parse_args()

    if args.cmd == "papers":
        out = get("/papers", {
            "query": args.query, "k": args.k,
            "categories": ",".join(args.category or []),
            "authors": ",".join(args.author or []),
            "from": args.date_from, "to": args.date_to,
        })
        show_papers(unwrap(out, "papers"))
    elif args.cmd == "paper":
        out = get(f"/papers/{args.id}", {})
        print(json.dumps(out.get("data", out), indent=2)[:4000])
    elif args.cmd == "read":
        out = get(f"/papers/{args.id}", {"query": args.question, "k": args.k})
        node = out.get("data", out)
        passages = node.get("passages") if isinstance(node, dict) else None
        passages = passages if isinstance(passages, list) else unwrap(out, "passages")
        if not passages:
            sys.exit(f"research: no passages returned: {json.dumps(out)[:300]}")
        if args.raw:
            for i, ps in enumerate(passages, 1):
                body = ps.get("text") or ps.get("passage") or ps.get("content") or json.dumps(ps)
                print(f"[passage {i}] {body[:2000]}\n")
        else:
            print(digest_answer(args.question, passages))
    elif args.cmd == "similar":
        out = get(f"/papers/{args.id}/similar", {"intent": args.intent, "mode": args.mode, "k": args.k})
        show_papers(unwrap(out, "papers"))
    elif args.cmd == "github":
        out = get("/github", {"query": args.query, "k": args.k})
        for r in unwrap(out, "results"):
            if not isinstance(r, dict):
                print(f"- {r}")
                continue
            url = r.get("url", "")
            label = r.get("title") or r.get("repository") or url.removeprefix("https://github.com/") or "?"
            print(f"- {label}\n  {url}")
            snippet = (r.get("snippet") or "").strip().replace("\n", " ")
            if snippet:
                print(f"  {snippet[:300]}")


if __name__ == "__main__":
    main()
