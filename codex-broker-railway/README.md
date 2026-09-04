# codex-broker

One refresher for a pool of Codex OAuth accounts, deployed on Railway.

VMs never hold a refresh token. When a VM's access token expires it asks the
broker for a fresh one. The broker is the only thing that ever refreshes (so
the rotating refresh tokens never collide across machines), and it hands out
access tokens that any number of VMs can share.

This is infrastructure alongside `star-fleet/` (the laptop app) and `vm-base/`
(what runs on each VM). It is not shipped to VMs. The app runs fine without it
on a plain OpenAI API key; this exists for people who own several ChatGPT
accounts and want a fleet to draw on them. You are responsible for staying
within OpenAI's terms for those accounts.

## Layout

```
codex-broker-railway/
├── src/
│   ├── main.ts      entry: load the store, start the HTTP server
│   ├── config.ts    env-derived configuration
│   ├── store.ts     the account pool and its volume-backed accounts.json
│   ├── oauth.ts     refresh and vend one account's token (serialized per account)
│   └── server.ts    HTTP routes, auth, and the /token vend logic
├── push-account.ts  operator CLI: push the locally logged-in account to the broker
├── probe_*.py       ops scripts for probing the live Codex backend (see CLIENT-GUIDE.md)
└── CLIENT-GUIDE.md  how to call the broker correctly from a client
```

## Why it exists

OpenAI rotates the Codex refresh token on every refresh. If two VMs refresh the
same account, the second gets `invalid_grant` and the account dies. Centralizing
refresh in one always-on service removes that failure mode and makes the pool
survive VM churn: rotations live here, on a Railway volume, not on disposable VM
disks.

## Endpoints

Everything except `/health` requires `Authorization: Bearer $RAILWAY_BROKER_API_KEY`.

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness (no auth); returns account count |
| `GET /accounts` | per-account state: `ready` / `cooldown` / `needs-relogin` |
| `POST /accounts` | hot-add or re-seed accounts at runtime, no restart |
| `DELETE /accounts?account=<label>` | drop a permanently dead account |
| `GET /token` | vend a token: recovered-from-rate-limit accounts first (longest-limited first), then fresh ones round-robin |
| `GET /token?account=account-3` | vend for a specific account |
| `GET /token?avoid=a,b,c` | vend anything except these labels |
| `GET /token?model=<id>` | rank accounts entitled to that model first |
| `POST /rate-limit?account=<label>` | a VM reports a usage limit; cool that account ~5h, then readmit |
| `POST /model-unsupported?account=<label>&model=<id>` | record a durable account/model gate |
| `GET /models` | the fleet-wide model allowlist (from `CODEX_MODELS`) |

### Rate-limit-aware rotation

ChatGPT Codex accounts ease their usage limits after roughly five hours. The
broker can't observe a usage limit directly (it only sees auth health), so the
VM reports it: when a turn fails with a rate-limit error the supervisor calls
`POST /rate-limit?account=<label>`. The broker then cools that account for
`CODEX_RATE_LIMIT_COOLDOWN_MS` (default 5h) so `/token` skips it, and readmits
it automatically once the cooldown lifts. On the next vend it prefers
previously-limited-but-recovered accounts, oldest limit first, then fresh
never-limited accounts round-robin. `?avoid=` keeps the account a VM just left
out of the immediate response.

`/token` returns `{ tier, access_token, account_id, label, expires_at }`. Tiers,
in order:

1. The regular pool (`tier: "codex-oauth"`)
2. The reserve account, added with `"reserve": true` and never in the
   round-robin (`tier: "codex-oauth-reserve"`)

If everything is exhausted: `503 {pool_exhausted:true}`. The VM then falls back
to its own OpenAI key (`agent-loop.sh`).

## Adding or fixing an account

New accounts drop straight into the pool running VMs are already polling. You
never restart the broker or touch the VMs.

```bash
rm -f ~/.codex/auth.json              # never `codex logout` (see below)
codex login --device-auth             # sign in as the target account
npm run push-account -- account-10    # push and verify (label of your choice)
npm run push-account -- codex-reserve --reserve   # for the reserve account
rm -f ~/.codex/auth.json              # done; the broker owns the chain now
```

Re-pushing an existing label replaces its refresh token and clears the
dead/cooldown flags. That's how you recover a `needs-relogin` account.

Never run `codex logout`. It revokes the account's server-side OAuth session,
which invalidates every token from that login, including the rotated refresh
token this broker holds ("Your session has ended"). That kills every account in
the pool and forces a full re-seed. To clear the local CLI, delete the file:
`rm -f ~/.codex/auth.json`. Once an account is pushed, don't use the Codex CLI
with it again; the broker is the only client allowed to refresh it.

## Rolling out a new model fleet-wide

`GET /models` returns the models the fleet may run, from `CODEX_MODELS`. Each
VM's tabs-repl `/model <m>` validates against this list at switch time, so
adding a model is one command and no VM redeploy:

```bash
railway variables --service codex-broker --set 'CODEX_MODELS=gpt-5.4,gpt-5.5,gpt-5.6-sol'
```

Within seconds any VM can `/model gpt-5.6-sol` (takes effect on the next turn).
The model string passes straight through to pi's `--model`; the broker never
inspects it. If the broker is unreachable, VMs fall back to a built-in
allowlist so they're never locked out.

Other model knobs, if you want to change defaults:

| What | Where |
| --- | --- |
| new-run default | `vm-base/scaffolding/agent-loop.sh` (`PI_MODEL`) and `tabs-repl.sh` (`DEFAULT_MODEL`) |
| VM tool digests | `vm-base/scaffolding/tools/llm_client.py` (`TABS_LLM_MODEL`) |
| lean-search augment/rerank | Railway service `lean-search` (`LEAN_LLM_MODEL`) |
| offline allowlist fallback | `vm-base/scaffolding/tabs-repl.sh` (`FALLBACK_MODELS`) |

## Config (Railway env vars)

- `RAILWAY_BROKER_API_KEY`: shared secret the VMs authenticate with.
- `CODEX_MODELS`: comma-separated model allowlist served at `/models`.
- `DATA_DIR`: volume mount persisting the rotated refresh tokens (default
  `/data`). This is the only account store; attach a Railway volume there.
- `CODEX_CLIENT_ID` / `CODEX_TOKEN_URL`: OAuth client and token endpoint.
  Defaults are the Codex CLI's public client. The refresh request is
  form-encoded, same as pi's own refresh.
- `CODEX_RATE_LIMIT_COOLDOWN_MS`: see above.

## Deploy

```bash
npm i -g @railway/cli
railway up --service codex-broker
railway variables --service codex-broker --set 'RAILWAY_BROKER_API_KEY=...'
railway domain                  # public URL -> RAILWAY_BROKER_URL in your .env
```

## Notes

- The repo `.env` holds no account credentials (they'd be stale after the first
  refresh). The Railway volume is the single source of truth. Inspect the live
  pool with `GET /accounts`.
- ChatGPT-backend model ids: `gpt-5.5` works, `gpt-5.5-codex` is API-only. The
  5.6 family needs the full id `gpt-5.6-sol`; bare `gpt-5.6` is rejected.
- `?force=1` on `/token` bypasses the access-token cache. Needed because ChatGPT
  can invalidate outstanding access tokens before their expiry.
