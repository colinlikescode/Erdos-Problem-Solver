"""common child - shared plumbing for the compute-broker children (gpu / cpu).

The brokers are the hidden TOOL half of the gpu-burst / cpu-burst skills: the
agent asks for capacity; the broker inspects LIVE provider state (what other
agents are actually running right now) and picks the platform. No shared lock
service - the providers themselves are the source of truth.

SDKs live in a private venv bootstrapped on first use by ../orchestrator.py.
"""
import json
import os
import subprocess
import sys

VENV = os.path.expanduser("~/.tabs/scaffolding/.venv")
VENV_PY = os.path.join(VENV, "bin", "python")
SDKS = ["modal", "daytona", "e2b"]


def _in_venv() -> bool:
    """Are we running UNDER the broker venv? Compare sys.prefix, NOT
    realpath(sys.executable): a venv's bin/python is a symlink to the system
    python, so realpath collapses them to the same path and we'd wrongly think
    we're already in the venv - running under system python (no provider SDKs),
    which makes every provider read 'unavailable' after the venv's first use.
    sys.prefix, however, is the venv dir when running the venv python and /usr
    otherwise, so it distinguishes them correctly."""
    return os.path.realpath(getattr(sys, "prefix", "")) == os.path.realpath(VENV)


def ensure_venv() -> None:
    """Re-exec under the broker venv, creating it (with provider SDKs) once."""
    if _in_venv():
        return
    if not os.path.exists(VENV_PY):
        print("[broker] first run: installing provider SDKs (about a minute)...", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "venv", VENV], check=True)
        subprocess.run(
            [os.path.join(VENV, "bin", "pip"), "install", "-q", *SDKS], check=True
        )
    os.execv(VENV_PY, [VENV_PY, *sys.argv])


def modal_busy(acct: int):
    """True if this Modal account has WORK RUNNING right now: an ephemeral app
    (a live `modal run`) or any app with running tasks. Long-lived `deployed`
    apps with 0 tasks are idle infrastructure, not usage.
    None = unconfigured or unknown (treated as unusable)."""
    token_id = os.environ.get(f"MODAL_TOKEN_ID_{acct}", "").strip()
    token_secret = os.environ.get(f"MODAL_TOKEN_SECRET_{acct}", "").strip()
    if not token_id or not token_secret:
        return None
    env = {**os.environ, "MODAL_TOKEN_ID": token_id, "MODAL_TOKEN_SECRET": token_secret}
    try:
        r = subprocess.run(
            [os.path.join(VENV, "bin", "modal"), "app", "list", "--json"],
            env=env, capture_output=True, text=True, timeout=90,
        )
        if r.returncode != 0:
            return None
        apps = json.loads(r.stdout or "[]")

        def running(a: dict) -> bool:
            state = str(a.get("state", a.get("State", ""))).lower()
            try:
                tasks = int(a.get("tasks", a.get("Tasks", 0)) or 0)
            except (TypeError, ValueError):
                tasks = 0
            return "ephemeral" in state or tasks > 0

        return any(running(a) for a in apps)
    except Exception:
        return None


def daytona_busy():
    """True if any Daytona sandbox exists (agents delete theirs when done)."""
    if not os.environ.get("DAYTONA_API_KEY", "").strip():
        return None
    try:
        from daytona import Daytona
        return len(list(Daytona().list())) > 0  # list() may be a generator
    except Exception:
        return None


def e2b_busy():
    """True if any E2B sandbox is currently running."""
    if not os.environ.get("E2B_API_KEY", "").strip():
        return None
    try:
        from e2b import Sandbox
        res = Sandbox.list()
        items = getattr(res, "next_items", None)
        boxes = res.next_items() if callable(items) else list(res)
        return len(boxes) > 0
    except Exception:
        return None


def fmt_state(busy) -> str:
    return "unavailable (no key / error)" if busy is None else ("BUSY" if busy else "free")
