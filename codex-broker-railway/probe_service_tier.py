"""Does service_tier change the gpt-5.6-sol overload rate?

The real Codex CLI sends a `service_tier` in the request body (values seen in
the binary: auto/default/priority/scale). Under capacity pressure a priority
tier is admitted ahead of the shed pool. This sweeps each tier and counts only
turns where text actually arrives.
"""

import concurrent.futures as cf
import itertools
import json
import os
import sys
import urllib.error
import urllib.request

BROKER = os.environ["RAILWAY_BROKER_URL"].rstrip("/")
KEY = os.environ["RAILWAY_BROKER_API_KEY"]
MODEL = "gpt-5.6-sol"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 15
TIERS = sys.argv[2].split(",") if len(sys.argv) > 2 else [
    "<none>",
    "auto",
    "default",
    "priority",
    "scale",
]
ACCTS = [f"account-{i}" for i in range(10, 23)]
CYC = itertools.cycle(ACCTS)


def vend(lb):
    req = urllib.request.Request(
        f"{BROKER}/token?account={lb}", headers={"Authorization": f"Bearer {KEY}"}
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def attempt(tier, lb):
    try:
        tok = vend(lb)
    except Exception as e:  # noqa: BLE001
        return "vend-fail"
    payload = {
        "model": MODEL,
        "instructions": "You are a helpful assistant.",
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "What is 2+2? One word."}]}
        ],
        "reasoning": {"effort": "medium"},
        "store": False,
        "stream": True,
    }
    if tier != "<none>":
        payload["service_tier"] = tier
    body = json.dumps(payload).encode()
    h = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {tok['access_token']}",
        "chatgpt-account-id": tok.get("account_id") or "",
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "accept": "text/event-stream",
    }
    req = urllib.request.Request(
        "https://chatgpt.com/backend-api/codex/responses", data=body, headers=h, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            got = False
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: ") or line[6:] == "[DONE]":
                    continue
                try:
                    ev = json.loads(line[6:])
                except Exception:  # noqa: BLE001
                    continue
                et = ev.get("type", "")
                if et == "response.output_text.delta" and ev.get("delta"):
                    got = True
                if et in ("error", "response.failed"):
                    err = ev.get("error") or (ev.get("response") or {}).get("error") or {}
                    return err.get("code") or "err"
            return "TEXT" if got else "no-text"
    except urllib.error.HTTPError as e:
        raw = e.read(200).decode("utf-8", "replace")
        return "gated" if "not supported" in raw else f"http{e.code}"
    except Exception as e:  # noqa: BLE001
        return type(e).__name__


print(f"model={MODEL}  n={N} per tier\n")
for tier in TIERS:
    jobs = [next(CYC) for _ in range(N)]
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        res = list(ex.map(lambda lb: attempt(tier, lb), jobs))
    ok = res.count("TEXT")
    reasons = {}
    for r in res:
        if r != "TEXT":
            reasons[r] = reasons.get(r, 0) + 1
    print(f"service_tier={tier.ljust(9)}  {ok}/{N} real text   {reasons}")
