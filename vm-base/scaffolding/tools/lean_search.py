#!/usr/bin/env python3
"""lean_search.py - natural-language search over Mathlib 4.

Describe the theorem/definition you want in plain English; returns the matching
Mathlib declarations (name, kind, signature, informal description). Backed by the
Tabs lean-search service (Gemini embeddings + Chroma + GPT-5.5 rerank) - you
never talk to an external site.

Usage:
  lean-search "the order of a group element divides the order of the group"
  lean-search "continuity of composition of continuous functions" --k 15
  lean-search "finite dimensional vector space basis" --kind theorem
  lean-search "..." --raw        # print JSON as-is

Env (set by the provisioner): RAILWAY_LEAN_SEARCH_URL, RAILWAY_LEAN_SEARCH_API_KEY.
"""
import argparse
import json
import os
import sys
import urllib.request


def main() -> None:
    p = argparse.ArgumentParser(description="Natural-language Mathlib search.")
    p.add_argument("query")
    p.add_argument("--k", type=int, default=10, help="results to return (1-50)")
    p.add_argument("--kind", help="filter: theorem | definition | instance | class | …")
    p.add_argument("--no-augment", action="store_true", help="skip query augmentation")
    p.add_argument("--raw", action="store_true", help="print raw JSON")
    args = p.parse_args()

    url = os.environ.get("RAILWAY_LEAN_SEARCH_URL", "").strip().rstrip("/")
    key = os.environ.get("RAILWAY_LEAN_SEARCH_API_KEY", "").strip()
    if not url or not key:
        sys.exit("lean-search: RAILWAY_LEAN_SEARCH_URL / RAILWAY_LEAN_SEARCH_API_KEY not set.")

    body = {"query": args.query, "k": args.k, "augment": not args.no_augment}
    if args.kind:
        body["kind"] = args.kind
    req = urllib.request.Request(
        f"{url}/search",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            out = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        sys.exit(f"lean-search: request failed: {e}")

    if args.raw:
        print(json.dumps(out, indent=2, ensure_ascii=False))
        return
    results = out.get("results") or []
    if not results:
        print("No results.")
        return
    for i, r in enumerate(results, 1):
        sig = " ".join((r.get("signature") or "").split())
        print(f"{i}. {r.get('name', '')}  [{r.get('kind', '')}]")
        if r.get("informal_name"):
            print(f"   {r['informal_name']}")
        if sig:
            print(f"   sig: {sig[:280]}")
        desc = (r.get("informal_description") or "").strip().replace("\n", " ")
        if desc:
            print(f"   {desc[:400]}")
        print()


if __name__ == "__main__":
    main()
