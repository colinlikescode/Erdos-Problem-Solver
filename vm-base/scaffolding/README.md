# scaffolding/

The machinery that makes the never-stop system work. Pi never sees these files:
the provisioner installs them at `~/.tabs/scaffolding/` on every VM, outside the
agent's working directory, so the agent can neither read nor edit the loop that
drives it. Agent-callable tools like `wait.sh` and `new-experiment` also live
here (in `tools/`) and are exposed on PATH. The split is about visibility, not
function.

```
scaffolding/
├── agent-loop.sh       the supervisor: re-invokes Pi forever, rotates auth
│                       tiers (codex-broker pool + reserve, then the regular
│                       key), and runs the context trigger: at ~90% of the
│                       window it makes the agent rewrite handoff.md, then
│                       compacts to a fresh session. Codex tokens are fetched
│                       from the codex-broker (RAILWAY_BROKER_URL) per turn;
│                       nothing codex-related is stored on the VM.
├── tabs-repl.sh        what the sidebar tab drops into. Commands:
│                       /start-new-agent, /stop-recursive-loop (kill the loop,
│                       unlock app edits, chat with the agent),
│                       /start-recursive-loop (resume), /model (switch gpt-5.x).
│                       The loop runs in the background; its pid
│                       (~/.tabs/agent-loop.pid) is the "agent is working"
│                       signal the app's edit lock checks.
├── reboot-resume.sh    @reboot cron hook. If the box reboots mid-run, restart
│                       the loop, but only if ~/.tabs/agent-should-run is set
│                       (a deliberately stopped or solved agent stays stopped).
├── brokers/            the tools behind the gpu-burst / cpu-burst skills
│   ├── orchestrator.py    single entry point: bootstraps the SDK venv, then
│   │                      dispatches gpu/cpu to the matching child
│   └── children/
│       ├── common.py    live provider-state checks (modal app list, daytona
│       │                sandbox list, e2b sandbox list) + SDK venv bootstrap
│       ├── gpu.py       gpu-burst: up to 10 H100s; daytona, then modal-1,
│       │                then modal-2, first idle provider wins
│       └── cpu.py       cpu-burst: up to 400 vCPUs; 200 or fewer goes to E2B
│                        (8 vCPU boxes), more goes to Cloudflare (4 vCPU
│                        boxes); E2B errors fall through to Cloudflare
└── tools/              agent-callable tool implementations. Each is installed
                        as a PATH command (wrapper in ~/.local/bin) so the agent
                        runs it by name and never reaches into scaffolding:
    ├── setup.sh              one-time toolchain setup (elan/Lean, Rust, Python
    │                         venv at the snapshot's .venv)
    ├── wait.sh               the sanctioned pause
    ├── requirements.txt      Python math deps installed by setup.sh
    ├── web_search.py         web-search: Firecrawl search + LLM digest
    ├── research.py           research-search: Firecrawl research index + digest
    ├── lean_search.py        lean-search: Mathlib NL search (lean-search-railway)
    ├── llm_client.py         shared LLM client for the digests (broker, then key)
    ├── text_operator.sh      text-operator: Sendblue text, then halt the loop
    ├── new-experiment.sh     start/fork an attempt (source only), re-link shared
    ├── new-fact.sh           mint the next verified_math fact: folder,
    │                         frontmatter entry.md, one-line ledger entry
    ├── experiment-template/  generic rust/cuda/lean skeleton new-experiment seeds
    └── cpu-worker/           Cloudflare driver Worker template (copied by the
                              cpu-burst grant when Cloudflare is chosen)
```

The compute `brokers/` here are unrelated to the `codex-broker-railway/`
service. Same word, different jobs: these pick GPU/CPU providers; that one
vends Codex auth tokens.

The brokers are agent-callable (thin `gpu-burst`/`cpu-burst` wrappers on PATH)
but their platform-selection policy is agent-invisible: the skill teaches only
"request N, follow the grant". Cross-agent coordination needs no shared state.
Each broker queries the providers' live workloads, so another agent's running
job automatically marks that provider busy fleet-wide.

## How it reaches VMs

`star-fleet/src/electron/provision/children/scaffolding.ts` base64-ships these
files into `~/.tabs/scaffolding/` on every provision (atomic write and rename,
so a running supervisor is never corrupted mid-read). The agent start command
runs the repl when the scaffolding is present and plain `pi` otherwise. The
supervisor takes the snapshot root from its cwd, never from its own location.

## The 90% trigger

1. Every turn runs in `--mode json`; the supervisor parses the session's token
   count from the output.
2. At or above `HANDOFF_PCT` (default 90%) of the effective context window, it
   sends the handoff prompt: stop work, rewrite `handoff.md` for a fresh agent.
3. It then compacts by rotating to a new Pi session and bootstraps it with the
   resume prompt (study the codebase, read handoff.md / verified_math/ /
   notebook.md, continue). Pi's own auto-compaction (seeded in
   `~/.pi/agent/settings.json` by the provisioner) stays on as a within-turn
   safety net.

## Editing rules

- Keep the supervisor cwd-driven and dependency-free (bash + python3 only).
- Any behavior change must keep `star-fleet/tests/unit/agentLoop.test.ts` (the
  stubbed-pi harness) green.
