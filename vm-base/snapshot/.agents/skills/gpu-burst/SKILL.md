---
name: gpu-burst
description: Request up to 10 individual H100 GPUs for a job (shard bigger runs across multiple grants). Run `gpu-burst request <n>` and the compute broker allocates GPUs for you, or tells you none are free right now. Use it whenever a step needs GPUs this VM lacks, such as CUDA kernels, batched matrix work, or big parallel searches. You never pick the platform; the broker does.
---

# gpu-burst

You don't choose or manage a GPU provider. You ask the broker for H100
capacity; it grants you GPUs and prints the instructions to run your job, or
tells you none are free right now.

## Request GPUs

```bash
gpu-burst request 8     # 1-10 individual H100s
```

- On `GRANTED ... gpus=<n> type=H100`, follow the printed instructions (env
  vars, install command, and a code snippet are all included).
- Up to 10 H100s per grant. Need more? Shard the job and place several grants
  or waves.
- `No GPUs available at this time` (exit 2) means all H100 capacity is in use.
  Do CPU work in the meantime and retry later, or `wait.sh 600 "gpu full"`.

## Check availability (optional)

```bash
gpu-burst status        # free / BUSY / unavailable
```

## Rules

- Tear down when done. If the grant had you create a sandbox, delete it the
  moment the job finishes; while it exists it holds a GPU slot for the whole
  fleet. One-shot jobs free themselves.
- Request only what the job needs. Grants are per job, not reservations. Ask
  again for the next job.
- The first call bootstraps the broker's SDKs (about a minute); later calls are
  instant.
- This costs money. Batch GPU work into a few well-planned jobs.
