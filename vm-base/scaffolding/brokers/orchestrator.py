#!/usr/bin/env python3
"""Compute-broker orchestrator - the single entry point behind the gpu-burst
and cpu-burst skills.

The agent-facing wrappers on PATH call this with a domain prefix:

    gpu-burst <args>  ->  orchestrator.py gpu <args>
    cpu-burst <args>  ->  orchestrator.py cpu <args>

The orchestrator bootstraps the shared SDK venv once, then dispatches to the
matching child in children/ (gpu.py / cpu.py; provider checks in common.py).
Policy (which provider wins, caps, ordering) lives entirely in the children  - 
this file only routes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from children.common import ensure_venv  # noqa: E402


def main() -> None:
    ensure_venv()
    args = sys.argv[1:]
    if not args or args[0] not in ("gpu", "cpu"):
        sys.exit("usage: orchestrator.py gpu|cpu request <n> | status")
    domain, rest = args[0], args[1:]
    if domain == "gpu":
        from children import gpu as child
    else:
        from children import cpu as child
    child.run(rest)


if __name__ == "__main__":
    main()
