"""True success rate for gpt-5.6-sol variants on the Codex path.

Counts a turn as successful only when text actually arrives. The backend
reports overload inside a 200 stream, so anything that scores on HTTP status
alone reports failures as successes.
"""

import concurrent.futures as cf
import json
import os
import sys
import urllib.error
import urllib.request

BROKER = os.environ["RAILWAY_BROKER_URL"].rstrip("/")
KEY = os.environ["RAILWAY_BROKER_API_KEY"]
N = int(sys.argv[1]) if len(sys.argv) > 1 else 12
MODELS = sys.argv[2].split(",") if len(sys.argv) > 2 else [
    "gpt-5.6-sol",
    "gpt-5.6-sol-thinking",
    "gpt-5.6",
    "gpt-5.5",
]


def vend(model):
    req = urllib.request.Request(
        f"{BROKER}/token?model={model}", headers={"Authorization": f"Bearer {KEY}"}
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def attempt(model, _i):
    try:
        tok = vend(model)
    except Exception as e:  # noqa: BLE001
        return "vend-fail", str(e)[:60], None
    body = json.dumps(
        {
            "model": model,
            "instructions": "You are a helpful assistant.",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "What is 2+2? One word."}],
                }
            ],
            "reasoning": {"effort": "medium"},
            "store": False,
            "stream": True,
        }
    ).encode()
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
    lb = tok.get("label")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            got = False
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload == "[DONE]":
                    continue
                try:
                    ev = json.loads(payload)
                except Exception:  # noqa: BLE001
                    continue
                et = ev.get("type", "")
                if et == "response.output_text.delta" and ev.get("delta"):
                    got = True
                if et in ("error", "response.failed"):
                    err = ev.get("error") or (ev.get("response") or {}).get("error") or {}
                    return "FAIL", err.get("code") or err.get("type") or "unknown", lb
            return ("OK", "text", lb) if got else ("FAIL", "no-text", lb)
    except urllib.error.HTTPError as e:
        raw = e.read(200).decode("utf-8", "replace")
        tag = "gated" if "not supported" in raw else f"http{e.code}"
        return "FAIL", tag, lb
    except Exception as e:  # noqa: BLE001
        return "FAIL", type(e).__name__, lb


for model in MODELS:
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        rows = list(ex.map(lambda i: attempt(model, i), range(N)))
    ok = sum(1 for s, _, _ in rows if s == "OK")
    reasons = {}
    for s, why, _ in rows:
        if s != "OK":
            reasons[why] = reasons.get(why, 0) + 1
    good_accts = sorted({lb for s, _, lb in rows if s == "OK" and lb})
    print(f"{model.ljust(22)} {ok}/{N} real text   failures={reasons}")
    if good_accts:
        print(f"{'':22} worked on: {good_accts}")
