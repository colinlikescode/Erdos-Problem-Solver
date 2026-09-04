"""cpu child - policy for the cpu-burst skill (dispatched by ../orchestrator.py).

Large burstable CPU jobs that can be SHARDED. The agent asks for a number of
vCPUs; the broker picks the platform and shards it into sandboxes. Under the
hood (the agent never picks):

    request <= 200 vCPU   -> E2B, 8 vCPU per sandbox   (ceil(vcpu/8) sandboxes)
    request  > 200 vCPU   -> Cloudflare, standard-4    (ceil(vcpu/4) sandboxes)
    hard ceiling          400 vCPU  (shard bigger jobs into waves)

E2B is skipped (Cloudflare instead) when it is already busy, and the E2B grant
tells the agent to fall back to Cloudflare if E2B errors/overloads at runtime.

Agent-facing usage (via the `cpu-burst` wrapper on PATH):
    cpu-burst request <vcpu>   allocate ~<vcpu> vCPUs (1-400); prints GRANTED ...
    cpu-burst status           show live provider state
"""
import math
import sys

from .common import e2b_busy, fmt_state

VCPU_MAX = 400          # hard ceiling on a single request
E2B_LIMIT_VCPU = 200    # <= this -> E2B, above -> Cloudflare
E2B_VCPU_PER = 8        # E2B: always the 8-vCPU instance
CF_VCPU_PER = 4         # Cloudflare: standard-4 (4 vCPU, 12 GiB, 20 GB disk)


def grant_e2b(vcpu: int) -> None:
    n = math.ceil(vcpu / E2B_VCPU_PER)
    print(f"GRANTED provider=e2b sandboxes={n} vcpu={n * E2B_VCPU_PER} (8 vCPU each)")
    print()
    print("Fan out with the E2B SDK (E2B_API_KEY already in your environment):")
    print("  pip install e2b   # once")
    print("  # per shard (always the 8-vCPU sandbox):")
    print("  from e2b import Sandbox")
    print('  with Sandbox.create(timeout=7200) as sb:')
    print('      sb.files.write("/home/user/job.py", SRC)')
    print('      out = sb.commands.run("python3 /home/user/job.py --shard N", timeout=0)')
    print()
    print(f"Drive the {n} shards in parallel with a ThreadPoolExecutor. Sandboxes die")
    print("with the context manager - E2B reads as free once your run ends.")
    print()
    print("FALLBACK: if E2B errors or is overloaded (create fails, timeouts), re-run")
    print(f"  cpu-burst request {vcpu} cloudflare")
    print("to get the same capacity on Cloudflare instead.")


def grant_cloudflare(vcpu: int) -> None:
    n = math.ceil(vcpu / CF_VCPU_PER)
    print(f"GRANTED provider=cloudflare sandboxes={n} vcpu={n * CF_VCPU_PER} (standard-4: 4 vCPU / 12 GiB / 20 GB each)")
    print()
    print("Use the driver Worker (template shipped at ~/.tabs/scaffolding/tools/cpu-worker/,")
    print("standard-4 instance type + image tag already set):")
    print('  export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_KEY"')
    print("  mkdir -p ~/.tabs/cf-sandbox && cp ~/.tabs/scaffolding/tools/cpu-worker/* ~/.tabs/cf-sandbox/")
    print("  cd ~/.tabs/cf-sandbox && npm init -y && npm i @cloudflare/sandbox && npm i -D wrangler")
    print("  npx wrangler deploy    # then poll `npx wrangler containers list` until ready")
    print()
    print(f"Fan out with ids shard-0..shard-{n - 1}: POST {{\"id\": \"shard-K\", \"cmd\": ...}}")
    print("to the worker URL. Full teardown when done is TWO deletes:")
    print("  npx wrangler delete --force && npx wrangler containers delete <ID>")


def cmd_status() -> None:
    print(f"e2b (<= {E2B_LIMIT_VCPU} vCPU, 8 vCPU/sandbox): {fmt_state(e2b_busy())}")
    print(f"cloudflare (> {E2B_LIMIT_VCPU} vCPU, standard-4): always available (overflow pool)")
    print(f"ceiling: {VCPU_MAX} vCPU per request")


def cmd_request(vcpu: int, force: str = "") -> None:
    if vcpu < 1:
        sys.exit("cpu-burst: request at least 1 vCPU.")
    if vcpu > VCPU_MAX:
        sys.exit(
            f"cpu-burst: {vcpu} exceeds the {VCPU_MAX}-vCPU ceiling. Shard the job into "
            f"waves of <= {VCPU_MAX} vCPU (finish one wave, then request the next)."
        )
    if force == "cloudflare":
        grant_cloudflare(vcpu)
    elif force == "e2b":
        grant_e2b(vcpu)
    elif vcpu <= E2B_LIMIT_VCPU and e2b_busy() is False:
        grant_e2b(vcpu)
    else:
        grant_cloudflare(vcpu)


def run(args: list) -> None:
    if len(args) == 1 and args[0] == "status":
        cmd_status()
    elif len(args) >= 2 and args[0] == "request":
        try:
            vcpu = int(args[1])
        except ValueError:
            sys.exit("cpu-burst: request takes a vCPU count, e.g. `cpu-burst request 200`.")
        force = args[2].lower() if len(args) >= 3 else ""
        if force and force not in ("e2b", "cloudflare"):
            sys.exit("cpu-burst: optional 3rd arg must be 'e2b' or 'cloudflare'.")
        cmd_request(vcpu, force)
    else:
        sys.exit(f"usage: cpu-burst request <1-{VCPU_MAX} vCPU> | cpu-burst status")
