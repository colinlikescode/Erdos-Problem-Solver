"""gpu child - policy for the gpu-burst skill (dispatched by ../orchestrator.py).

Grants up to 10 individual H100 GPUs (shard bigger jobs) by picking the first
free provider in this preference order, checked against live provider state:

    daytona  →  modal account 1  →  modal account 2  →  none available

Each provider offers up to 10 H100s, so the pool is ~30 total. When all three
are in use the skill returns a generic "no GPUs available right now".

Agent-facing usage (via the `gpu-burst` wrapper on PATH):
    gpu-burst request <n>   allocate n GPUs (1-10); prints GRANTED ... or the
                            no-capacity message
    gpu-burst status        show live free/busy state
"""
import sys

from .common import modal_busy, daytona_busy, fmt_state

MAX_GPUS = 10


def grant_modal(acct: int, n: int) -> None:
    print(f"GRANTED provider=modal-{acct} gpus={n} type=H100")
    print()
    print("Run your job on this account (tokens already in your environment):")
    print(f'  export MODAL_TOKEN_ID="$MODAL_TOKEN_ID_{acct}" MODAL_TOKEN_SECRET="$MODAL_TOKEN_SECRET_{acct}"')
    print("  pip install modal   # once")
    print("  modal run your_gpu_app.py")
    print()
    print("Define the container image declaratively in the app (built platform-side):")
    print('  image = modal.Image.debian_slim().pip_install("numpy")  # or from_registry(')
    print('  #   "nvidia/cuda:12.4.0-devel-ubuntu22.04", add_python="3.12") for nvcc')
    if n <= 8:
        print(f'  @app.function(gpu="H100:{n}", image=image, timeout=3600)')
    else:
        print(f'  # Modal caps 8 GPUs per container: fan out, e.g. gpu="H100:8" + gpu="H100:{n - 8}".')
    print()
    print("Jobs are one-shot (modal run tears down on completion). When your job")
    print("finishes, the account reads as free again automatically.")


def grant_daytona(n: int) -> None:
    print(f"GRANTED provider=daytona gpus={n} type=H100")
    print()
    print("Create a GPU sandbox (DAYTONA_API_KEY already in your environment):")
    print("  pip install daytona   # once")
    print("  python3 - <<'EOF'")
    print("from daytona import (Daytona, DaytonaConfig, CreateSandboxFromImageParams,")
    print("                     Image, Resources, GpuType)")
    print('daytona = Daytona(DaytonaConfig(target="us-east-1"))')
    print("sandbox = daytona.create(CreateSandboxFromImageParams(")
    print('    image=Image.debian_slim("3.12"), auto_delete_interval=0,')
    print(f"    resources=Resources(gpu={n}, gpu_type=[GpuType.H100]),")
    print("))")
    print("print(sandbox.id)")
    print("EOF")
    print()
    print("(Alternative: the prebuilt GPU snapshot  - ")
    print('  daytona.create(CreateSandboxFromSnapshotParams(snapshot="daytona-gpu")))')
    print("DELETE the sandbox the moment you are done (sandbox.delete()) - while it")
    print("exists, daytona reads as BUSY for every other agent.")


def cmd_status() -> None:
    # Preference order: daytona, then modal account 1, then modal account 2.
    for name, busy in (
        ("daytona", daytona_busy()),
        ("modal-1", modal_busy(1)),
        ("modal-2", modal_busy(2)),
    ):
        print(f"{name}: {fmt_state(busy)}")


def cmd_request(n: int) -> None:
    if not 1 <= n <= MAX_GPUS:
        sys.exit(f"gpu-burst: request 1-{MAX_GPUS} GPUs (got {n}).")
    # 1st daytona, 2nd modal account 1, 3rd modal account 2.
    if daytona_busy() is False:
        grant_daytona(n)
        return
    for acct in (1, 2):
        if modal_busy(acct) is False:
            grant_modal(acct, n)
            return
    # All ~30 H100 slots across the pool are in use - stay generic.
    print("No GPUs available at this time - all H100 capacity is in use right now.")
    print("Do CPU work in the meantime and retry later; capacity frees up when")
    print("running jobs finish. Use wait.sh if you are blocked on this.")
    sys.exit(2)


def run(args: list) -> None:
    if len(args) == 1 and args[0] == "status":
        cmd_status()
    elif len(args) == 2 and args[0] == "request":
        try:
            n = int(args[1])
        except ValueError:
            sys.exit("gpu-burst: request takes a number, e.g. `gpu-burst request 5`.")
        cmd_request(n)
    else:
        sys.exit(f"usage: gpu-burst request <1-{MAX_GPUS}> | gpu-burst status")
