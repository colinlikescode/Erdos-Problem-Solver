"""End-to-end check that a failing Codex call rolls onto a DIFFERENT account.

Mimics exactly what a VM does: vend a token for a model, call the Codex
endpoint, and on failure re-vend with every already-tried account in `avoid`.
Passes if either a call succeeds or the chain visits distinct accounts until
the pool is exhausted -- never the same account twice in a row.
"""

import json
import os
import sys
import urllib.error
import urllib.request

BROKER = os.environ["RAILWAY_BROKER_URL"].rstrip("/")
KEY = os.environ["RAILWAY_BROKER_API_KEY"]
MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-5.6-sol"
MAX_HOPS = int(sys.argv[2]) if len(sys.argv) > 2 else 8
CODEX = "https://chatgpt.com/backend-api/codex/responses"


def vend(avoid):
    q = f"{BROKER}/token?model={MODEL}"
    if avoid:
        q += "&avoid=" + ",".join(avoid)
    req = urllib.request.Request(q, headers={"Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def call_codex(tok, account_id):
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
    # Headers mirror the production caller exactly. Sending a `version` header
    # opts into a CLI-version gate that rejects every model with HTTP 400,
    # which reads as a missing entitlement but is nothing of the sort.
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {tok}",
        "chatgpt-account-id": account_id or "",
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "accept": "text/event-stream",
    }
    req = urllib.request.Request(CODEX, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            # The Codex path reports overload INSIDE a 200 stream, so HTTP
            # status alone reads a failed turn as a success.
            got_text = False
            for raw in r:
                line = raw.decode("utf-8", "replace")
                if '"output_text.delta"' in line:
                    got_text = True
                if '"response.failed"' in line or '"type": "error"' in line:
                    try:
                        err = json.loads(line[6:]).get("error") or {}
                        code = err.get("code") or err.get("type") or "unknown"
                    except Exception:  # noqa: BLE001
                        code = "unknown"
                    return False, f"in-stream {code}"
            if got_text:
                return True, f"HTTP {r.status} with text"
            return False, f"HTTP {r.status} but no text"
    except urllib.error.HTTPError as e:
        detail = e.read(400).decode("utf-8", "replace").replace("\n", " ")
        return False, f"HTTP {e.code}: {detail}"
    except Exception as e:  # noqa: BLE001
        return False, f"{type(e).__name__}: {e}"


tried, ok = [], False
for hop in range(1, MAX_HOPS + 1):
    try:
        v = vend(tried)
    except Exception as e:  # noqa: BLE001
        print(f"hop {hop}: vend FAILED: {e}")
        break
    label = v.get("label")
    repeat = " <-- REPEAT, fallback broken" if label in tried else ""
    good, why = call_codex(v.get("access_token"), v.get("account_id"))
    print(f"hop {hop}: {label}{repeat} -> {'OK' if good else 'fail'} | {why[:150]}")
    if good:
        ok = True
        break
    if label in tried:
        print("FAIL: broker handed back an account already tried")
        sys.exit(1)
    tried.append(label)

print()
print(f"model={MODEL} hops={len(tried) + (1 if ok else 0)} distinct={len(set(tried))} success={ok}")
