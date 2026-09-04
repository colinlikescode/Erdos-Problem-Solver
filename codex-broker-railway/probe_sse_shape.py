"""Dump the full SSE event shape of a Codex response.

"HTTP 200 but no text" is being read as OpenAI capacity. It is equally
consistent with the client watching for the wrong event type, or giving up
before a long reasoning phase emits anything. This records every event type,
its arrival time, and where the text actually lives.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

BROKER = os.environ["RAILWAY_BROKER_URL"].rstrip("/")
KEY = os.environ["RAILWAY_BROKER_API_KEY"]
MODEL = sys.argv[1] if len(sys.argv) > 1 else "gpt-5.6-sol"
EFFORT = sys.argv[2] if len(sys.argv) > 2 else "high"
PROMPT = sys.argv[3] if len(sys.argv) > 3 else "What is 2+2? Answer in one word."


def vend():
    req = urllib.request.Request(
        f"{BROKER}/token?model={MODEL}", headers={"Authorization": f"Bearer {KEY}"}
    )
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


tok = vend()
print(f"model={MODEL} effort={EFFORT} account={tok.get('label')}")

body = json.dumps(
    {
        "model": MODEL,
        "instructions": "You are a helpful assistant.",
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": PROMPT}],
            }
        ],
        "reasoning": {"effort": EFFORT},
        "store": False,
        "stream": True,
    }
).encode()
headers = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {tok['access_token']}",
    "chatgpt-account-id": tok.get("account_id") or "",
    "OpenAI-Beta": "responses=experimental",
    "originator": "codex_cli_rs",
    "accept": "text/event-stream",
}
req = urllib.request.Request(
    "https://chatgpt.com/backend-api/codex/responses",
    data=body,
    headers=headers,
    method="POST",
)

t0 = time.time()
counts, text_parts, first_text_at = {}, [], None
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        print(f"HTTP {r.status}  (headers at {time.time() - t0:.1f}s)\n")
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data: "):
                continue
            payload = line[6:]
            if payload == "[DONE]":
                counts["[DONE]"] = counts.get("[DONE]", 0) + 1
                continue
            try:
                ev = json.loads(payload)
            except Exception:  # noqa: BLE001
                counts["<unparseable>"] = counts.get("<unparseable>", 0) + 1
                continue
            et = ev.get("type", "<no-type>")
            if et not in counts:
                print(f"  {time.time() - t0:7.1f}s  first {et}")
            # An in-stream failure arrives under HTTP 200, so the payload is the
            # only place the real reason is stated.
            if et in ("error", "response.failed", "response.incomplete"):
                print(f"      PAYLOAD: {json.dumps(ev)[:600]}")
            counts[et] = counts.get(et, 0) + 1
            if et == "response.output_text.delta":
                if first_text_at is None:
                    first_text_at = time.time() - t0
                text_parts.append(ev.get("delta") or "")
            # Where the finished text lives if deltas never arrive
            if et == "response.completed":
                resp = ev.get("response") or {}
                for item in resp.get("output") or []:
                    for c in item.get("content") or []:
                        if c.get("type") in ("output_text", "text") and c.get("text"):
                            counts["<text-in-completed>"] = 1
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}: {e.read(300).decode('utf-8', 'replace')[:200]}")
    sys.exit(1)

elapsed = time.time() - t0
print(f"\nelapsed={elapsed:.1f}s  first_text_at={first_text_at}")
print(f"delta_text_len={len(''.join(text_parts))}")
print("event counts:")
for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
    print(f"  {v:5d}  {k}")
print("\ntext:", "".join(text_parts)[:300] or "<EMPTY>")
