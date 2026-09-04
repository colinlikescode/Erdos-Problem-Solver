# vm-base/ - everything that runs inside a research VM

The rule for this repo: `star-fleet/` is the app on the laptop, `vm-base/` is
everything that ends up on a VM. If a file executes on a VM it lives here. If it
executes in the Electron app it lives in `star-fleet/`.

There are two layers, split by one question: is it in the agent's context
window?

```
vm-base/
├── snapshot/     the agent's context window only: what Pi reads and writes
│   ├── AGENTS.md        operating doctrine (never stop, checker first, ...)
│   ├── problem.md       the math problem for this snapshot
│   ├── notebook.md / handoff.md / verified_math/ / check_answer/
│   ├── workspace/       shared/ (heavy reusable inputs: prebuilt Lean+Mathlib,
│   │                    datasets, libs) + experiments/ (thin per-attempt code;
│   │                    fork via new-experiment)
│   └── .agents/skills/  six skills, each just a SKILL.md documenting a PATH
│                        command (gpu-burst, cpu-burst, web-search,
│                        research-search, lean-search, text-operator). The
│                        folder Pi auto-discovers. See its README.
└── scaffolding/  everything else: machinery and tool implementations Pi can't
    │             see. Installed at ~/.tabs/scaffolding, exposed only via PATH.
    ├── agent-loop.sh      never-stop supervisor; 90%-context handoff then
    │                      compact; fetches Codex tokens from the broker per turn
    ├── tabs-repl.sh       the sidebar shell (/start-new-agent, /stop-...,
    │                      /start-..., /model)
    ├── reboot-resume.sh
    ├── brokers/           compute brokers behind gpu-burst/cpu-burst
    └── tools/             agent-callable tool implementations, each installed
                           as a PATH command
```

- `snapshot/` is copied to a VM as the agent's working directory. It holds only
  what enters the agent's context: the standing docs, its working folders, and
  the `SKILL.md` docs. No tool implementations.
- `scaffolding/` is everything the agent runs but never sees. The provisioner
  installs it at `~/.tabs/scaffolding/` and drops a thin PATH wrapper in
  `~/.local/bin` for each agent-callable command (see
  `star-fleet/src/electron/provision/children/scaffolding.ts`). It lives
  outside the agent's working directory so Pi can never see or edit the loop
  that drives it.
- The sidebar tab drops into `tabs-repl`. The autonomous run does not
  auto-start: the user preps `problem.md`, types `/start-new-agent`, and
  intervenes with `/stop-recursive-loop` (chat, unlock edits) then
  `/start-recursive-loop`. While the loop runs, the app locks manual edits.
- Snapshot placement is automatic. The provisioner puts it on the VM at
  `~/snapshot` on first connect and never overwrites an existing one. New tabs
  open `~/snapshot`.

## Editing rules

- Snapshot content changes: keep `snapshot/AGENTS.md` section 3 and the
  structure tests (`star-fleet/tests/unit/snapshotStructure.test.ts`) in sync.
- Scaffolding changes: keep the supervisor cwd-driven; the stubbed-pi harness
  in `star-fleet/tests/unit/agentLoop.test.ts` must stay green.
- Nothing in here may import from or depend on `star-fleet/`. The dependency
  points one way: the app ships VM files, never the reverse.
