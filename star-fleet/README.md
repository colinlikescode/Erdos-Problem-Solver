# star-fleet/ - the Tabs desktop app (everything that runs on the laptop)

Electron + Next.js (static export) + Monaco editor + xterm.js + ssh2 - a native
app rendering the remote filesystem over SFTP, not an IDE fork.
The counterpart folder, `../vm-base/`, holds everything that executes on the
research VMs; this app only *ships* those files (see the repo-root README for
the one-rule split and the user flow).

## Map

```
src/electron/                 main process
├── main.ts                   window + IPC wiring; reads repo-root ../.env
├── agentEnv.ts               .env/settings -> remote agent env (SKILL_PROVIDER_KEYS)
├── profiles.ts               saved machines (SSH route + key OR password), JSON in userData
├── settings.ts               OpenAI keys entered in-app (override .env)
├── problems.ts               saved problems (the New-run picker)
├── digitalocean.ts           one-click droplet spin-up (cloud-init, random root pw)
├── r2.ts / runs.ts           Cloudflare R2 run saves + continues (chassis/cargo split)
├── preload.ts                renderer bridge
├── session/                  orchestrator.ts (SessionManager: one Session per
│                             profile) + children/{connection,session} (ssh2 key/
│                             password + SFTP + agent PTY via tmux)
└── provision/                builders for the idempotent VM provision script
    ├── orchestrator.ts       composes the sections below -> {script, stamp}
    └── children/
        ├── sections.ts       base setup (lock, instance-id, env), tmux, Pi,
        │                     snapshot placement (~/snapshot, never clobbered)
        ├── auth.ts           Pi OpenAI auth seeding
        ├── scaffolding.ts    supervisor + tabs-repl + brokers + tools install
        └── shell.ts          quoting/b64 helpers, readImageAsset, snapshotTarB64

src/app/ + src/components/    Next.js renderer (Home/How-it-works, tab strip,
                              FileTree, Monaco viewer, agent panel, dialogs)
src/shared/                   types, SSH route parser, save-lineage tree

tests/unit/                   bun test - provision (bash-validated), auth, env,
                              agent-loop (stubbed pi), vm-base structure (enforced)
tests/integration/            opt-in droplet e2e (costs money; never in CI)
```

## Commands (run from this folder)

```bash
bun install
bun run dev        # tsc electron + next dev :3210 + Electron
bun run typecheck  # both tsconfigs
bun test           # unit tests
bun run test:live  # droplet e2e (skips without the SSH key)
```

## Rules of thumb

- The provision script is built from pure functions in `provision/` - every
  section has unit tests that bash-validate the generated script. Change a
  section, run `bun test`.
- Anything the VM needs at runtime is an asset in `../vm-base/`, read at
  build time via `readImageAsset`/`snapshotTarB64` - never inline VM code here.
- New provider keys go in `SKILL_PROVIDER_KEYS` (agentEnv.ts) + tests; they
  flow to `~/.tabs-agent.env` on every VM automatically.
