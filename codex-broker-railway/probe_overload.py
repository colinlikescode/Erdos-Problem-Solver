#!/usr/bin/env python3
"""Measure which Codex-path request shapes hit server_is_overloaded.

The failure is intermittent, so a single call proves nothing: each variant is
sampled N times and reported as a success rate. Each sample vends a fresh token
so no single account skews the result.

  python3 probe_overload.py [samples]
"""
import json
import os
import sys
import time
import urllib.request

BROKER = os.environ["RAILWAY_BROKER_URL"].rstrip("/")
BKEY = os.environ["RAILWAY_BROKER_API_KEY"]
CODEX = "https://chatgpt.com/backend-api/codex/responses"
N = int(sys.argv[1]) if len(sys.argv) > 1 else 3

VARIANTS = [
    ("gpt-5.6-sol", "max"),
    ("gpt-5.6-sol", "high"),
    ("gpt-5.6-sol", "medium"),
    ("gpt-5.6-sol", "low"),
    ("gpt-5.5", "max"),
    ("gpt-5.5", "high"),
    ("gpt-5.4", "high"),
]


def vend():
    req = urllib.request.Request(f"{BROKER}/token", headers={"Authorization": f"Bearer {BKEY}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def call(model, effort, tok):
    body = {
        "model": model,
        "instructions": "You are a helpful assistant.",
        "input": [{"type": "message", "role": "user",
                   "content": [{"type": "input_text", "text": "Reply with the single word: ok"}]}],
        "reasoning": {"effort": effort, "summary": "auto"},
        "store": False,
        "stream": True,
    }
    req = urllib.request.Request(
        CODEX,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {tok['access_token']}",
            "chatgpt-account-id": tok["account_id"],
            "OpenAI-Beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "accept": "text/event-stream",
            "content-type": "application/json",
        },
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            status = r.status
            saw_error = None
            completed = False
            service_tier = None
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    ev = json.loads(payload)
                except Exception:
                    continue
                if ev.get("type") == "error":
                    saw_error = ev.get("error", {}).get("code") or ev.get("error", {}).get("type")
                    break
                if ev.get("type") == "response.completed":
                    completed = True
                    service_tier = (ev.get("response") or {}).get("service_tier")
                    break
                resp = ev.get("response") or {}
                if resp.get("service_tier"):
                    service_tier = resp["service_tier"]
                if resp.get("status") == "failed":
                    err = (resp.get("error") or {})
                    saw_error = err.get("code") or err.get("type") or "failed"
                    break
            return {"http": status, "ok": completed, "err": saw_error,
                    "tier": service_tier, "secs": round(time.time() - t0, 1)}
    except Exception as e:
        return {"http": getattr(e, "code", 0), "ok": False,
                "err": f"{type(e).__name__}:{str(e)[:60]}", "tier": None,
                "secs": round(time.time() - t0, 1)}


print(f"samples per variant: {N}")
for model, effort in VARIANTS:
    results = []
    for _ in range(N):
        try:
            tok = vend()
        except Exception as e:
            results.append({"ok": False, "err": f"vend:{e}"})
            continue
        results.append(call(model, effort, tok))
        time.sleep(1)
    ok = sum(1 for r in results if r.get("ok"))
    errs = {}
    for r in results:
        if not r.get("ok"):
            errs[r.get("err")] = errs.get(r.get("err"), 0) + 1
    tiers = {r.get("tier") for r in results if r.get("tier")}
    print(json.dumps({
        "model": model, "effort": effort,
        "ok": f"{ok}/{len(results)}",
        "errors": errs,
        "service_tier": sorted(t for t in tiers if t),
        "secs": [r.get("secs") for r in results],
    }), flush=True)
