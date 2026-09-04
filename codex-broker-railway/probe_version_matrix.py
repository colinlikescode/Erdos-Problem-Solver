"""Which request shape unlocks gpt-5.6-sol on the Codex (ChatGPT-account) path?

Two different HTTP 400s have been seen, and they mean opposite things:
  "requires a newer version of Codex"        -> the version header is too old
  "not supported ... with a ChatGPT account" -> the model is gated for this caller
Sweeps every account x header variant so the difference is measured, not guessed.
"""

import concurrent.futures as cf
import json
import os
import sys
import urllib.error
import urllib.request

BROKER = os.environ["RAILWAY_BROKER_URL"].rstrip("/")
KEY = os.environ["RAILWAY_BROKER_API_KEY"]
MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-5.6-sol"
CODEX = "https://chatgpt.com/backend-api/codex/responses"

VARIANTS = {
    "no-version": {},
    "v0.104.0": {"version": "0.104.0"},
    "v0.146.0": {"version": "0.146.0"},
    "v0.146.0+session": {
        "version": "0.146.0",
        "session_id": "00000000-0000-0000-0000-000000000000",
    },
}


def accounts():
    req = urllib.request.Request(
        f"{BROKER}/accounts", headers={"Authorization": f"Bearer {KEY}"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    return [a["label"] for a in d.get("accounts", d)]


def vend(label):
    req = urllib.request.Request(
        f"{BROKER}/token?account={label}", headers={"Authorization": f"Bearer {KEY}"}
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def classify(label, variant):
    try:
        tok = vend(label)
    except Exception as e:  # noqa: BLE001
        return "vend-fail", str(e)[:80]
    body = json.dumps(
        {
            "model": MODEL,
            "instructions": "You are a helpful assistant.",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Say OK."}],
                }
            ],
            "stream": True,
            "store": False,
        }
    ).encode()
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {tok['access_token']}",
        "chatgpt-account-id": tok.get("account_id") or "",
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "accept": "text/event-stream",
        **VARIANTS[variant],
    }
    req = urllib.request.Request(CODEX, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            r.read(200)
            return "OK", f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        raw = e.read(300).decode("utf-8", "replace")
        if "newer version" in raw:
            return "old-version", f"{e.code}"
        if "not supported when using Codex with a ChatGPT account" in raw:
            return "chatgpt-gated", f"{e.code}"
        if "overloaded" in raw:
            return "overloaded", f"{e.code}"
        return f"{e.code}", raw.replace("\n", " ")[:90]
    except Exception as e:  # noqa: BLE001
        return type(e).__name__, str(e)[:80]


labels = accounts()
print(f"model={MODEL}  accounts={len(labels)}\n")
grid = {}
with cf.ThreadPoolExecutor(max_workers=16) as ex:
    futs = {
        ex.submit(classify, lb, v): (lb, v) for lb in labels for v in VARIANTS
    }
    for f in cf.as_completed(futs):
        lb, v = futs[f]
        grid[(lb, v)] = f.result()

hdr = "account".ljust(12) + "".join(v.ljust(20) for v in VARIANTS)
print(hdr)
print("-" * len(hdr))
for lb in sorted(labels, key=lambda s: int(s.split("-")[-1])):
    row = lb.ljust(12)
    for v in VARIANTS:
        row += grid[(lb, v)][0].ljust(20)
    print(row)

print("\n=== totals per variant ===")
for v in VARIANTS:
    tally = {}
    for lb in labels:
        k = grid[(lb, v)][0]
        tally[k] = tally.get(k, 0) + 1
    ok = tally.get("OK", 0)
    print(f"{v.ljust(20)} OK={ok}/{len(labels)}  {tally}")
