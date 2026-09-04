---
name: cpu-burst
description: Request up to 400 vCPUs of burst CPU for a large, shardable job (search shards, isolated builds, parameter sweeps, untrusted runs), anything you can split into independent pieces that run in parallel. Run `cpu-burst request <vcpus>` and the broker provisions and shards the capacity for you across ephemeral sandboxes. Use it whenever local CPU is the bottleneck. You never pick the platform; the broker does.
---

# cpu-burst

For large CPU jobs that can be sharded: work you can split into independent
pieces (search shards, sweeps, batch builds) that run in parallel across many
ephemeral sandboxes. You ask for a number of vCPUs; the broker provisions the
sandboxes and tells you how to fan out. You don't choose or manage the
platform.

## Request capacity

```bash
cpu-burst request 200     # 1-400 vCPUs; the broker shards it into sandboxes
```

- On `GRANTED ... sandboxes=<k> vcpu=<v>`, follow the printed instructions.
  They tell you how many parallel shards you have and how to drive them. Split
  your job into that many shards.
- The ceiling is 400 vCPUs per request. Shard bigger jobs into waves: finish
  one, then request the next.

## Check availability (optional)

```bash
cpu-burst status
```

## Rules

- This is for embarrassingly parallel work only. If the job can't be split it
  won't benefit; run it locally.
- Tear down when done. The grant prints the exact teardown commands. Lingering
  capacity blocks other agents.
- Precompile binaries locally when possible and ship them into the shards;
  toolchains are not preinstalled.
- Persist results back to this VM (`verified_math/`, `workspace/`) before the
  sandboxes exit. They are ephemeral.
- The first call bootstraps the broker's SDKs (about a minute); later calls are
  instant.
