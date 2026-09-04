<p align="right"><a href="https://starfleetmath.com">starfleetmath.com</a></p>

# Star Fleet

Star Fleet is a Mac app for running AI agents that work on open math problems,
around the clock, on rented servers. Running GPT-5.6 Sol as the base model, it
has solved 14 Erdős problems so far.

You give it a problem. It rents a big Linux server, installs a coding agent on
it, and tells the agent to start working. The agent writes code, runs
experiments, proves lemmas in Lean, and keeps a ledger of everything it has
verified. It doesn't stop when your laptop closes. It doesn't stop when the
server reboots. It stops when it solves the problem, or when it needs you, and
then it texts you.

You can run as many of these as you want. Each one gets its own server and its
own tab in the app.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## What you see

The app is one window with tabs. Each tab is one server. Inside a tab:

- a file tree and a code editor showing the files on that server
- a panel on the right where you watch the agent think and work, and where you
  can type to it

The Home screen lists your servers and problems and has buttons to add a
server or start a new run.

## How it works

There are three parts.

**The app on your Mac.** An Electron app. It connects to each server over SSH,
shows you the files, and runs a small setup script on the server the first time
you open it. That script installs the agent and everything it needs. The app
also holds your API keys and sends the ones the agent needs to the server.

**The server.** Any Ubuntu box you can SSH into, or a DigitalOcean droplet the
app creates for you with one click. On it lives:

- `~/snapshot`: the agent's working folder. It has the problem, the rules the
  agent follows (`AGENTS.md`), a notebook, and a folder of verified results.
- a supervisor script the agent can't see. It runs the agent in a loop forever,
  restarts it if it crashes, and when the agent's context window fills up it
  makes the agent write a handoff note and starts a fresh session from that
  note.

Everything runs inside tmux, so closing your laptop changes nothing.

**The agent.** [Pi](https://github.com/earendil-works/pi-coding-agent), a
coding agent, running an OpenAI model (the shipped default is `gpt-5.5:xhigh`;
the Erdős results were with `gpt-5.6-sol`, switchable with `/model`). It has a
few extra abilities on top of a normal shell:

- `gpu-burst` and `cpu-burst`: ask for H100s or hundreds of CPU cores. A broker
  picks the cloud provider.
- `web-search`, `research-search`, `lean-search`: look things up on the web, in
  papers, and in Mathlib.
- `text-operator`: send you a text message. The agent is only allowed to use
  this when it is completely stuck, needs far more GPUs than it can get, or has
  solved the problem. Sending a text also stops the loop until you restart it.

## Using it

1. Add a server. Paste an SSH address and a key or password, or click "New
   DigitalOcean VM".
2. Open it. The first open takes a few minutes while the setup script runs.
   After that it's instant.
3. Write the problem in `problem.md`.
4. Type `/start-new-agent` in the right-hand panel. The agent starts.

While the agent is running, the editor is read-only. To talk to it or change
files, type `/stop-recursive-loop`, do what you need, then
`/start-recursive-loop`.

You can save a run to Cloudflare R2 and continue it later on a new server.

## Cost

This spins up real cloud machines on your accounts. The default DigitalOcean
server is 60 CPUs and 120 GB of RAM, about $1,639 a month while it's on. The GPU
and CPU burst skills spend money on your Modal, Daytona, E2B and Cloudflare
accounts. Nothing is created until you click a button, but know what you're
clicking.

## Setup

You need a Mac and [Bun](https://bun.sh).

```bash
git clone <this repo> star-fleet
cd star-fleet
cp .env.example .env      # add your keys
cd star-fleet
bun install
bun run dev
```

The only key you truly need is an OpenAI API key (`OPENAI_REGULAR_API_KEY`).
Every other key in `.env.example` turns on one feature. Leave the rest blank
and those features just won't be available.

The server needs Ubuntu or Debian with root or passwordless sudo. The setup
script installs everything else.

## Repo layout

```
star-fleet/             the Mac app
vm-base/                everything that gets copied onto a server
  snapshot/               the agent's working folder
  scaffolding/            the supervisor, the sidebar shell, and the tools behind the skills
codex-broker-railway/   optional: a small service that lets several servers share ChatGPT accounts
lean-search-railway/    optional: a small service that does natural-language search over Mathlib
```

Each folder has its own README. `handoff.md` at the root has the details a
maintainer needs.

## Development

```bash
cd star-fleet
bun run typecheck   # both tsconfigs
bun test            # unit tests; also checks the vm-base scripts and layout
```

Rules of the road: code that runs on the Mac goes in `star-fleet/`, code that
runs on a server goes in `vm-base/`, and `vm-base/` never imports from
`star-fleet/`. Don't commit `.env`. If you add a key the agent needs, add it to
`.env.example` and to `SKILL_PROVIDER_KEYS` in `agentEnv.ts`. The integration
tests under `star-fleet/tests/integration/` create real droplets and cost
money, so they're opt-in and never run in CI.

## License

MIT, Colin Snyder. See [LICENSE](LICENSE).
