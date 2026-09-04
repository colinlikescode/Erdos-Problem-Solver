#!/usr/bin/env python3
"""Per-account success rate for gpt-5.6-sol on the Codex path.

Decides whether "accounts that work for 5.6-sol" is a real, stable set (worth
preferring in the broker) or whether failure is uniformly random across the
pool (in which case a preference list would be fitting noise).

All accounts probed concurrently; N samples each.
"""
import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BROKER = os.environ["RAILWAY_BROKER_URL"].rstrip("/")
BKEY = os.environ["RAILWAY_BROKER_API_KEY"]
CODEX = "https://chatgpt.com/backend-api/codex/responses"
MODEL = "gpt-5.6-sol"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 4


def api(path):
    r = urllib.request.Request(f"{BROKER}{path}", headers={"Authorization": f"Bearer {BKEY}"})
    return json.load(urllib.request.urlopen(r, timeout=30))


def one(tok):
    body = {
        "model": MODEL,
        "instructions": "You are a helpful assistant.",
        "input": [{"type": "message", "role": "user",
                   "content": [{"type": "input_text", "text": "Reply with the single word: ok"}]}],
        "reasoning": {"effort": "high", "summary": "auto"},
        "store": False, "stream": True,
    }
    req = urllib.request.Request(CODEX, data=json.dumps(body).encode(), headers={
        "Authorization": f"Bearer {tok['access_token']}",
        "chatgpt-account-id": tok["account_id"],
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "accept": "text/event-stream",
        "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            for raw in r:
                l = raw.decode("utf-8", "replace").strip()
                if not l.startswith("data:"):
                    continue
                p = l[5:].strip()
                if not p or p == "[DONE]":
                    continue
                try: ev = json.loads(p)
                except Exception: continue
                if ev.get("type") == "error":
                    return ev["error"].get("code") or "error"
                if ev.get("type") == "response.completed":
                    return "OK"
                rp = ev.get("response") or {}
                if rp.get("status") == "failed":
                    return (rp.get("error") or {}).get("code") or "failed"
        return "no-terminal"
    except urllib.error.HTTPError as e:
        return f"HTTP{e.code}"
    except Exception as e:
        return type(e).__name__


def check(lab):
    outs = []
    for _ in range(N):
        try:
            tok = api(f"/token?account={lab}")
        except Exception as e:
            outs.append(f"vend:{type(e).__name__}")
            continue
        outs.append(one(tok))
    ok = sum(1 for o in outs if o == "OK")
    return {"account": lab, "ok": ok, "n": len(outs), "results": outs}


accounts = api("/accounts")
rows = accounts if isinstance(accounts, list) else accounts.get("accounts", accounts)
if isinstance(rows, dict):
    rows = [{"account": k} for k in rows]
labels = [r.get("account") or r.get("label") for r in rows]

with ThreadPoolExecutor(max_workers=len(labels) or 1) as ex:
    res = list(ex.map(check, labels))

res.sort(key=lambda r: (-r["ok"], r["account"]))
for r in res:
    print(f"{str(r['account']).ljust(12)} {r['ok']}/{r['n']}  {','.join(r['results'])[:70]}")

tot_ok = sum(r["ok"] for r in res)
tot_n = sum(r["n"] for r in res)
working = [r["account"] for r in res if r["ok"] > 0]
print("\n" + json.dumps({
    "model": MODEL,
    "pool_success": f"{tot_ok}/{tot_n}",
    "accounts_with_any_success": len(working),
    "accounts_all_fail": len(res) - len(working),
    "working": working,
}, indent=1))
