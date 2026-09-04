# Star Fleet - technical notes

Internal notes for whoever works on this next. The READMEs describe what each
folder is; this file is the stuff you'd otherwise have to rediscover.

## What it is

A macOS desktop app for running many autonomous coding agents in parallel, each
on its own remote VM, from one window. You provision VMs, put the research
snapshot (`vm-base/snapshot/`) on each, and run the Pi agent against an open
math problem. Close the laptop and the agents keep going (tmux on the VM);
reopen and you reattach.

The app is still called "Tabs" in a lot of identifiers (`~/.tabs`, `tabs-repl`,
the tmux session name, `[tabs]` log prefixes). Don't rename those casually: the
provision stamp, tests and VMs in the wild all depend on them.

## Layout rule

Four top-level folders, split by where the code runs:

- `star-fleet/` - the laptop app. Run all `bun` commands from here.
- `vm-base/` - everything that ends up on a VM. `snapshot/` is placed at
  `~/snapshot` once and never overwritten. `scaffolding/` is installed at
  `~/.tabs/scaffolding` and is deliberately outside the agent's working dir.
  It's called vm-base rather than "image" because Modal/Daytona images are
  something else (ephemeral burst containers the brokers define at job time).
- `codex-broker-railway/` - always-on Railway service, the single refresher for
  a pool of Codex OAuth accounts. Not shipped to VMs.
- `lean-search-railway/` - always-on Railway service, natural-language Mathlib
  search behind the `lean-search` skill.

The dependency points one way: the app ships VM files, never the reverse.
Secrets live in the repo-root `.env` (see `.env.example`).

## User flow

1. Add a machine. Either connect an existing host (SSH route plus key or
   password) or create a DigitalOcean droplet. The droplet is `c-60-intel`
   (60 vCPU / 120 GB / 750 GB, Ubuntu 24.04, nyc1, about $1,639/mo). Root
   password auth is enabled via cloud-init with a random password minted per
   droplet and stored in the profile. The form has an optional problem textarea
   that pre-fills `~/snapshot/problem.md`.
2. Open it. The provisioner runs (idempotent), places `~/snapshot`, installs
   Pi and the scaffolding. There's no folder picker; tabs open `~/snapshot`.
   Reopen is instant: the script writes its own hash to
   `~/.tabs/provision-stamp` and `Session.open()` skips setup when the stamp
   matches and the agent tmux is alive. Any code/env/seed change alters the
   stamp and forces a real reprovision. Pi extensions are marker-guarded
   (`~/.tabs/ext-<pkg>.ok`) so they install once.
3. Edit `problem.md` in the tab.
4. `/start-new-agent` in the sidebar. The loop runs in its own process group in
   the background (pid in `~/.tabs/agent-loop.pid`). While it runs, file edits
   from the app are refused (`session.writeFile` checks the pid file).
   `/stop-recursive-loop` kills the loop, unlocks edits and drops you into a chat
   on the agent's session (`~/.tabs/last-session`). `/start-recursive-loop`
   resumes with the same session (RESUME=1). Those three plus `/model` are the
   whole human command surface. The run never auto-starts.

## Architecture

Electron + Next.js (static export) + Monaco + xterm.js + ssh2. It renders the
remote filesystem over SFTP; it is not an IDE fork.

```
star-fleet/src/electron/
  main.ts            window + IPC; reads ../.env; do:spinup handler
  digitalocean.ts    droplet create, cloud-init, wait-for-SSH
  agentEnv.ts        .env + settings -> agent env (SKILL_PROVIDER_KEYS)
  profiles.ts        saved machines (key or password, optional seed problem)
  settings.ts        keys entered in-app (override .env)
  problems.ts        saved problems
  r2.ts, runs.ts     run saves / continues on Cloudflare R2
  session/           SessionManager + ssh2 connection, SFTP, agent PTY
  provision/         builders for the provision script (pure functions,
                     bash-validated in tests)

vm-base/snapshot/    what the agent sees: AGENTS.md, problem.md, dependencies.md,
                     notebook.md, handoff.md, verified_math/, check_answer/,
                     workspace/{shared,experiments}, .agents/skills/*/SKILL.md
vm-base/scaffolding/ agent-loop.sh (supervisor), tabs-repl.sh, reboot-resume.sh,
                     brokers/ (gpu/cpu provider selection), tools/ (every
                     PATH command the skills document)
```

`check_answer/` and `workspace/*` are empty directories. Git doesn't track
those, so the provisioner `mkdir -p`s them after extracting the snapshot.

## The agent stack on a VM

- Pi (`@earendil-works/pi-coding-agent`) with the `openai-codex` provider.
  Settings are merged into `~/.pi/agent/settings.json`, never overwritten (that
  file also holds pi's package install records).
- Default model `gpt-5.5:xhigh`. No max-completion-tokens anywhere.
- Auth tiers, in order: codex-broker token (fetched per turn, written into pi's
  `openai-codex` credential) then the regular OpenAI key. The supervisor
  rotates accounts on rate limits, compacts at 90% context, and never exits on
  its own. The only agent-initiated stop is `text-operator`.
- Tool LLM calls (web-search digest, research digest) go through
  `scaffolding/tools/llm_client.py`, same tiers as the agent: broker token
  against `chatgpt.com/backend-api/codex/responses` (SSE; headers
  `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`,
  `originator: codex_cli_rs`), falling back to `api.openai.com/v1/responses`.
  Gemini is used for embeddings only.
- Compute: `gpu-burst request N` (up to 10 H100; Daytona, then Modal 1, then
  Modal 2, by live provider state). `cpu-burst request N` (up to 400 vCPU; 200
  or fewer goes to E2B 8-vCPU boxes, more goes to Cloudflare 4-vCPU containers,
  E2B errors fall through to Cloudflare). The skills only document the
  interface; the policy lives in `scaffolding/brokers/`.
- `~/.tabs/instance-id` is a 6-hex id minted at provision; text-operator tags
  messages with it.
- Live transcript: `do_turn` pipes pi's JSON stream through
  `~/.tabs/think-stream.py` (written by agent-loop.sh at boot) into
  `~/.tabs/agent-thinking.jsonl`, one `{"k","v","t"}` event per line. Turns run
  for hours, so this has to happen during the turn, not after. The Agent panel
  tails this file. The exit code comes from `PIPESTATUS[0]` so error
  classification is unaffected by the tee.

## Context window and compaction

The handoff-then-compact trigger fires at `HANDOFF_PCT` (90%) of the effective
window, which depends on provider and model (`context_window_for()`):

- raw OpenAI API, gpt-5.x: 1,000,000
- openai-codex (ChatGPT backend): 400,000. A real xhigh turn reached ~260k
  tokens with no pi auto-compaction, so the true window is comfortably above
  272k; 400k matches what we've seen. Override per VM with `PI_CONTEXT_WINDOW`.

`context_overflow()` detects context-length errors and compacts on the same
provider instead of failing over to another account. Pi's own auto-compaction
(`reserveTokens: 16384`) is the within-turn backstop. Overflow and rate-limit
classification reads only pi's structured `errorMessage`, not the raw turn
text, otherwise an agent researching "rate limits" would rotate accounts.
Tests cover both tiers, overflow-to-compact, and the false-positive guard.

## Model switching

`/model gpt-5.4` in tabs-repl writes `~/.tabs/agent-model`; the supervisor
re-reads it at the start of every turn. A bare model id gets `:xhigh`. The
allowlist comes from the broker's `GET /models` (env `CODEX_MODELS`), so adding
a model fleet-wide is one Railway env change and no VM redeploy. If the broker
is unreachable the repl falls back to a built-in list so nobody gets locked out.

ChatGPT-backend model ids: `gpt-5.4`, `gpt-5.5`, `gpt-5.6-sol`. `gpt-5.5-codex`
is API-only and the bare `gpt-5.6` alias is rejected.

## codex-broker

OpenAI rotates the Codex refresh token on every refresh, so two machines
refreshing the same account kill it. The broker is the only thing that ever
refreshes; VMs get short-lived access tokens from `/token`. Rotated refresh
tokens live on a Railway volume (`/data/accounts.json`).

- Tiers: pool (round-robin, rate-limit-aware) then the optional reserve
  account (`reserve: true`), then `503 {pool_exhausted:true}`, at which point
  the VM falls back to its regular OpenAI key.
- Adding an account: `rm -f ~/.codex/auth.json`, `codex login --device-auth`,
  `npm run push-account -- <label> [--reserve]`. Re-pushing a label replaces a
  dead chain. No restart, no VM interruption.
- Never run `codex logout`. It revokes the server-side session, which kills the
  broker's rotated refresh token too. Delete `~/.codex/auth.json` instead.
- The refresh request is form-encoded, same as pi's own refresh. Client id is
  the Codex CLI public client (`CODEX_CLIENT_ID` to override).
- `.env` holds no account blobs; `resolveAgentEnv` drops any if
  `RAILWAY_BROKER_URL` is set.

Railway: `RAILWAY_ACCOUNT_API_TOKEN` creates services/volumes via GraphQL,
`RAILWAY_PROJECT_API_TOKEN` deploys. The CLI can't link a directory with the
project token; `railway up` needs `--service`.

## verified_math format

Two tiers, strictly:

- `verified_math.md` is one line per fact:
  `- **F-003** (aka F-3, T19) [lean|pos] title: one sentence -> F-003_slug/`.
  Full statements never go in the ledger; a fresh agent re-reads the whole
  ledger for a few thousand tokens.
- `F-<nnn>_<slug>/entry.md` has frontmatter (`id, title, aliases, tier,
  polarity, depends_on, supersedes, verifier, date`) then the full statement,
  proof sketch and artifacts. `depends_on` is greppable, so
  `rg "depends_on:.*F-002"` is the reverse dependency graph.
- Facts are immutable; a correction mints a new fact with `supersedes:`.
- `new-fact <slug> [--tier ...] [--negative] [--depends ...] [--supersedes ...]`
  mints the id, folder and ledger line. It has a functional test.

## Run saves and continues (R2)

Bucket `starfleet-run-saves` (ENAM, near the nyc droplets). A snapshot is split
into two disjoint sets (`runs.ts`):

- chassis (base-owned, never saved or restored): AGENTS.md, dependencies.md,
  .agents/
- cargo (run-owned, saved in full including build caches): problem.md,
  notebook.md, handoff.md, verified_math/, check_answer/, workspace/

Because the sets are disjoint a continue is an overlay, nothing merges.

Save refuses while the loop is running (same pid-file check as the edit lock).
It streams `tar -czf -` from the VM straight to R2 via presigned URLs and writes
`runs/<problemId>/<runId>/manifest.json` (formatVersion, problem.md sha256, fact
count). Continue provisions a fresh VM with the current chassis, then the
restore hook streams the cargo from R2 into `tar -x` (chassis paths excluded
again on the VM side), drops `~/.tabs/continue-codebase` so the supervisor uses
the continue prompt, and writes `~/.tabs/restore-done` for exactly-once. Drift
(problem.md hash mismatch, formatVersion skew) is surfaced as session log lines.

Every save records `parentRunId` (from `~/.tabs/parent-run`, written by the
restore), so a problem's saves form a tree. `src/shared/saveTree.ts` builds and
flattens it for the picker; orphans become roots.

R2 upload: do not go back to `@aws-sdk/lib-storage`. It hangs against R2 on slow
links (the CompleteMultipartUpload deferred-200 body has no SDK timeout,
Cloudflare's 120s proxy timeout severs it, and SDK >= 3.729 sends CRC32 headers
R2 answers 501 to). `r2.ts` stages to a temp file and does independent presigned
PUTs: one PUT up to 4 GiB, manual multipart above that, each part with a
full-body timeout and retries. The S3 credentials are derived from the
Cloudflare token as (token id, sha256(token)).

## Long-run resilience

- Reboots kill tmux. `reboot-resume.sh` runs from an `@reboot` cron and restarts
  the loop only if `~/.tabs/agent-should-run` exists. That marker is set by
  `/start-new-agent` and `/start-recursive-loop`, cleared by
  `/stop-recursive-loop` and by text-operator. A deliberately stopped agent
  stays stopped.
- `agent-loop.log` grows ~3 KB per turn; `rotate_log()` caps it at
  `AGENT_LOG_MAX_BYTES` (~20 MB) and keeps the recent half.
- The outer loop never gives up: cooldown, retry from the broker, compact on
  overflow, back off on crashes. Only text-operator or a human stops it.
- The provision lock is an flock on fd 9. Both tmux spawns close it (`9>&-`),
  otherwise the long-lived tmux daemon inherits the lock and the next provision
  blocks forever.

## Things that bit us

- DigitalOcean's Ubuntu image ships node 18 with no npm. The installer checks
  for node < 22 or missing npm, and pipes NodeSource to `$SUDO bash -` (with
  `-E` the argv gets mangled when running as root).
- Pi's ESM needs node >= 22.
- `log()` in agent-loop.sh must append, not tee: tabs-repl already redirects
  stdout to the log, so tee doubled every line.
- The Chroma key is tenant-scoped, so a bare `CloudClient()` gets "Permission
  denied"; always pass apiKey/tenant/database. Chroma Cloud rate-limits per
  database; lean-search gates to 4 in-flight queries with jittered backoff.
- The `mathlib` collection is 1536-dim. Dims are fixed at first write; changing
  them means wiping and re-ingesting (~50 min).
- gpt-5.5:xhigh turns on a hard problem can run 20+ minutes. The supervisor's
  per-turn wait is minutes, not seconds. That's not a hang.
- The edit lock is enforced in the main process, not just the UI. The
  CodeViewer shows the refusal inline and keeps the buffer dirty.

## Testing

From `star-fleet/`:

- `bun test` - unit suite. Covers provision (generated script is
  bash-validated), auth seeding, agentEnv, the supervisor against a stubbed pi
  and a fake broker, snapshot/scaffolding structure, the real codex-broker
  booted against a stubbed OAuth endpoint, DigitalOcean cloud-init.
- `HOST=user@ip KEY=... bun run test:live` - droplet e2e.
- `bash tests/integration/full-lifecycle.sh` - creates a throwaway droplet,
  provisions it twice (idempotency), drives the whole tabs-repl surface with a
  stub pi, tests durability across an SSH disconnect, destroys the droplet
  (`KEEP=1` to keep it). Costs money.

## Dead ends

Things that were tried and removed. Don't bring them back without a reason:

1. SSH-orchestration launcher with native windows. Can't tab on macOS.
2. VNC/Xpra pixel streaming. Latency.
3. code-server in an iframe. Laggy.
4. A VS Code fork. Can't do one window, many remotes.
5. OpenCode with three providers. Replaced by Pi + OpenAI.
6. Memora memory runtime. Didn't help; the agent's durable memory is
   `handoff.md` + `verified_math/` + `notebook.md`.
7. Git/GitHub for run persistence. Replaced by R2 saves; the provisioner still
   scrubs the old sync script off older VMs.
8. Broker as a full proxy. Refresh-and-vend is enough; pi speaks the ChatGPT
   backend protocol itself.
9. Gemini Flash for tool digests and rerank. Swapped to GPT-5.5 through the
   broker chain. Gemini is embeddings only.
10. The `pi-codex-token` PAT provider and a paid-API-key tier in the broker.
