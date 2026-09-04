"""llm_client.py - GPT-5.5 (xhigh reasoning) completions for the VM tools.

One `complete(prompt)` used by the digest layers (web-search, research-search).
Provider fallback mirrors the supervisor's tier order exactly:

  1. codex-broker (RAILWAY_BROKER_URL): vends a ChatGPT Codex access token  - 
     the broker itself round-robins the pooled accounts, then falls to the
     big-budget reserve. The token is used against the Codex Responses backend.
  2. OPENAI_API_KEY: the regular OpenAI Responses API - last resort.

Not a PATH command: the tools import it (same directory on the VM).
"""
import json
import os
import urllib.error
import urllib.request

CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
OPENAI_URL = "https://api.openai.com/v1/responses"
MODEL = os.environ.get("TABS_LLM_MODEL", "gpt-5.5")
EFFORT = os.environ.get("TABS_LLM_EFFORT", "xhigh")


def _sse_output_text(resp) -> str:
    """Collect the output_text deltas from a Responses SSE stream."""
    text = []
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data: "):
            continue
        try:
            ev = json.loads(line[6:])
        except ValueError:
            continue
        if ev.get("type") == "response.output_text.delta":
            text.append(ev.get("delta", ""))
    return "".join(text)


def _codex_complete(prompt: str, timeout: int) -> str:
    """Tier 1: broker-vended ChatGPT token -> Codex Responses backend (SSE)."""
    broker = os.environ.get("RAILWAY_BROKER_URL", "").strip().rstrip("/")
    key = os.environ.get("RAILWAY_BROKER_API_KEY", "").strip()
    if not broker or not key:
        raise RuntimeError("no broker configured")
    req = urllib.request.Request(
        f"{broker}/token", headers={"Authorization": f"Bearer {key}"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        tok = json.loads(r.read().decode("utf-8"))
    if not tok.get("access_token"):
        raise RuntimeError(f"broker vend failed: {json.dumps(tok)[:200]}")

    body = {
        "model": MODEL,
        "instructions": "You are a careful research assistant.",
        "input": [{
            "type": "message", "role": "user",
            "content": [{"type": "input_text", "text": prompt}],
        }],
        "reasoning": {"effort": EFFORT},
        "store": False,
        "stream": True,  # the Codex backend only speaks SSE
    }
    req = urllib.request.Request(
        CODEX_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {tok['access_token']}",
            "chatgpt-account-id": tok.get("account_id", ""),
            "OpenAI-Beta": "responses=experimental",
            "originator": "codex_cli_rs",
            "accept": "text/event-stream",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = _sse_output_text(resp).strip()
    if not out:
        raise RuntimeError("codex backend returned no text")
    return out


def _openai_complete(prompt: str, timeout: int) -> str:
    """Tier 2: the regular OpenAI key against the public Responses API."""
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("no OPENAI_API_KEY")
    body = {
        "model": MODEL,
        "input": prompt,
        "reasoning": {"effort": EFFORT},
    }
    req = urllib.request.Request(
        OPENAI_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = json.loads(resp.read().decode("utf-8"))
    parts = []
    for item in out.get("output", []):
        if item.get("type") == "message":
            for c in item.get("content", []):
                if c.get("type") == "output_text":
                    parts.append(c.get("text", ""))
    text = "".join(parts).strip()
    if not text:
        raise RuntimeError(f"openai returned no text: {json.dumps(out)[:200]}")
    return text


def complete(prompt: str, timeout: int = 900) -> str:
    """GPT-5.5 xhigh completion: broker pool -> reserve -> OpenAI key."""
    errors = []
    for tier in (_codex_complete, _openai_complete):
        try:
            return tier(prompt, timeout)
        except Exception as e:  # noqa: BLE001 - fall to the next tier, keep why
            errors.append(f"{tier.__name__}: {e}")
    raise RuntimeError("all LLM tiers failed - " + " | ".join(errors))
