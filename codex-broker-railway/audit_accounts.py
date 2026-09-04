#!/usr/bin/env python3
"""Parallel liveness audit of the Codex account pool.

For every account the broker knows: vend a token for THAT account, then probe a
known-good model. This separates a dead/unauthable account from a healthy one,
independent of the model-scoped gpt-5.6-sol overload.

All accounts are probed concurrently.
"""
import json
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BROKER = os.environ["RAILWAY_BROKER_URL"].rstrip("/")
BKEY = os.environ["RAILWAY_BROKER_API_KEY"]
CODEX = "https://chatgpt.com/backend-api/codex/responses"
GOOD = "gpt-5.5"


def api(path):
    r = urllib.request.Request(f"{BROKER}{path}", headers={"Authorization": f"Bearer {BKEY}"})
    return json.load(urllib.request.urlopen(r, timeout=30))


def probe(tok, model=GOOD):
    body = {
        "model": model,
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
                    return ev["error"].get("code") or ev["error"].get("type")
                if ev.get("type") == "response.completed":
                    return "OK"
                rp = ev.get("response") or {}
                if rp.get("status") == "failed":
                    return (rp.get("error") or {}).get("code") or "failed"
        return "no-terminal-event"
    except urllib.error.HTTPError as e:
        detail = ""
        try: detail = e.read().decode()[:120]
        except Exception: pass
        return f"HTTP{e.code} {detail}"
    except Exception as e:
        return type(e).__name__


def check(entry):
    lab, state = entry
    try:
        tok = api(f"/token?account={lab}")
    except urllib.error.HTTPError as e:
        body = ""
        try: body = e.read().decode()[:120]
        except Exception: pass
        return {"account": lab, "broker_state": state, "alive": False,
                "why": f"vend HTTP{e.code} {body}"}
    except Exception as e:
        return {"account": lab, "broker_state": state, "alive": False, "why": f"vend {type(e).__name__}"}
    res = probe(tok)
    return {"account": lab, "broker_state": state, "alive": res == "OK", "why": res}


accounts = api("/accounts")
rows = accounts if isinstance(accounts, list) else accounts.get("accounts", accounts)
if isinstance(rows, dict):
    rows = [{"account": k, **(v if isinstance(v, dict) else {"state": v})} for k, v in rows.items()]
entries = [((r.get("account") or r.get("label")), (r.get("state") or r.get("status"))) for r in rows]

with ThreadPoolExecutor(max_workers=len(entries) or 1) as ex:
    results = list(ex.map(check, entries))

results.sort(key=lambda r: int(str(r["account"]).split("-")[-1]) if str(r["account"]).split("-")[-1].isdigit() else 0)
for r in results:
    mark = "ALIVE" if r["alive"] else "DEAD "
    print(f"{mark} {str(r['account']).ljust(12)} broker={str(r['broker_state']).ljust(10)} {r['why'][:90]}")

alive = [r["account"] for r in results if r["alive"]]
dead = [r["account"] for r in results if not r["alive"]]
print("\n" + json.dumps({"total": len(results), "alive": len(alive), "dead": len(dead), "dead_accounts": dead}, indent=1))
