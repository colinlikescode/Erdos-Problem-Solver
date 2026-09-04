// HTTP surface: request routing, auth, and the three-tier /token vend logic.
//
// Endpoints (all except /health require `Authorization: Bearer $RAILWAY_BROKER_API_KEY`):
//   GET    /health           liveness (no auth)
//   GET    /accounts         status of every account (no secrets)
//   POST   /accounts         hot-add / re-seed accounts (no restart)
//   DELETE /accounts?account=<label>   drop one account
//   GET    /token            vend a fresh access token. Tiers, in order:
//                            1. regular accounts - recovered-from-rate-limit
//                               first (longest-limited first), then fresh
//                               (round-robin) (tier codex-oauth)
//                            2. The reserve big-budget account (codex-oauth-reserve)
//                            ?account=<label> pins one; ?force=1 bypasses the
//                            cache; ?avoid=<a,b,c> excludes every account the
//                            caller already tried; ?model=<m> prefers accounts
//                            entitled to that model (see /model-unsupported).
//   POST   /model-unsupported?account=<label>&model=<m>   the backend rejected
//                            the model for this account (HTTP 400 = missing
//                            entitlement); rank it last for that model
//   POST   /rate-limit?account=<label>   a VM reports a usage/rate limit -> cool
//                            the account ~5h so the broker skips then readmits it
//   GET    /models           the fleet-wide model allowlist (from CODEX_MODELS)
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RAILWAY_BROKER_API_KEY, ALLOWED_MODELS } from "./config.js";
import { listAccounts, persist, usable, supportsModel, markModelUnsupported, clearModelUnsupported, markRateLimited, setDisabled, upsertAccount, removeAccount, type AccountInput } from "./store.js";
import { tokenFor } from "./oauth.js";

let rr = 0; // round-robin cursor across the regular pool

function send(res: ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function authed(req: IncomingMessage): boolean {
  const h = req.headers["authorization"] || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  return Boolean(RAILWAY_BROKER_API_KEY) && tok === RAILWAY_BROKER_API_KEY;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

async function handleAccounts(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const accounts = listAccounts();
  // Hot-add / re-seed accounts at runtime - no restart, no VM interruption.
  // Body: {label?, account_id, refresh_token} OR {accounts:[…]}.
  if (req.method === "POST") {
    const body = await readBody(req);
    if (!body) return send(res, 400, { error: "invalid JSON" });
    const list = (Array.isArray(body.accounts) ? body.accounts : [body]) as AccountInput[];
    const added: string[] = [];
    try {
      for (const a of list) added.push(upsertAccount(a));
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
    persist();
    return send(res, 200, { added, total: accounts.length });
  }
  // DELETE /accounts?account=label - drop one (e.g. a permanently dead login).
  if (req.method === "DELETE") {
    const removed = removeAccount(url.searchParams.get("account"));
    persist();
    return send(res, 200, { removed, total: accounts.length });
  }
  return send(res, 200, {
    accounts: accounts.map((a) => ({
      label: a.label,
      account_id: a.account_id,
      reserve: Boolean(a.reserve),
      last_refresh: a.last_refresh || null,
      state: a.disabled ? "disabled" : a.dead ? "needs-relogin" : usable(a) ? "ready" : "cooldown",
      unsupported_models: a.unsupported_models || [],
      // when a rate-limit cooldown lifts (ms epoch), for observability
      cooldown_until: a.cooldown_until && a.cooldown_until > Date.now() ? a.cooldown_until : null,
    })),
  });
}

/** POST /disable?account=<label>&on=1|0 - operator toggle: take an account out
 *  of rotation indefinitely (offline login etc.) WITHOUT discarding its tokens.
 *  on=0 re-enables. */
function handleDisable(res: ServerResponse, url: URL): void {
  const label = url.searchParams.get("account");
  if (!label) return send(res, 400, { error: "account required" });
  const on = url.searchParams.get("on") !== "0";
  const a = setDisabled(label, on);
  if (!a) return send(res, 404, { error: `no account ${label}` });
  persist();
  return send(res, 200, { label: a.label, disabled: Boolean(a.disabled) });
}

/** POST /rate-limit?account=<label> - a VM reports it hit a usage/rate limit on
 *  this account. Cool it ~5h (RATE_LIMIT_COOLDOWN_MS) so the broker skips it and
 *  readmits it automatically once the limit likely eased. */
function handleRateLimit(res: ServerResponse, url: URL): void {
  const label = url.searchParams.get("account");
  if (!label) return send(res, 400, { error: "account required" });
  const a = markRateLimited(label);
  if (!a) return send(res, 404, { error: `no account ${label}` });
  persist();
  return send(res, 200, { label: a.label, cooldown_until: a.cooldown_until });
}

/** POST /model-unsupported?account=<label>&model=<m> - the Codex backend
 *  rejected this model for this account with HTTP 400 (missing entitlement, not
 *  a usage limit). Rank the account last for that model; it keeps serving every
 *  other model. `&clear=1` undoes it if entitlement is later granted. */
function handleModelUnsupported(res: ServerResponse, url: URL): void {
  const label = url.searchParams.get("account");
  const model = url.searchParams.get("model");
  if (!label || !model) return send(res, 400, { error: "account and model required" });
  const a = url.searchParams.get("clear") === "1"
    ? clearModelUnsupported(label, model)
    : markModelUnsupported(label, model);
  if (!a) return send(res, 404, { error: `no account ${label}` });
  persist();
  return send(res, 200, { label: a.label, unsupported_models: a.unsupported_models || [] });
}

async function handleToken(res: ServerResponse, url: URL): Promise<void> {
  const accounts = listAccounts();
  const pin = url.searchParams.get("account");
  // force=1 bypasses the access-token cache (caller saw 401 token_invalidated).
  const force = url.searchParams.get("force") === "1";
  if (pin) {
    const acct = accounts.find((a) => a.label === pin);
    if (!acct) return send(res, 404, { error: `no account ${pin}` });
    try {
      return send(res, 200, await tokenFor(acct, force));
    } catch (e) {
      return send(res, 502, { error: (e as Error).message });
    }
  }
  // Tier 1: usable REGULAR accounts (skip dead + cooled-down). Order implements
  // the "re-check the longest-rate-limited accounts first" rule - Codex accounts
  // ease their limits after ~5h, so once an account's cooldown lifts we retry it
  // before burning a fresh one:
  //   (a) previously-limited-but-recovered accounts, oldest-limit first (the one
  //       limited longest ago recovered longest ago), then
  //   (b) never-limited fresh accounts, round-robined for fleet spread.
  // `model` ranks entitlement ahead of everything else: an account the Codex
  // backend rejects for this model (HTTP 400) can never serve it, so trying it
  // is a wasted vend. Those accounts are still offered as a fallback, because
  // they serve every other model perfectly well.
  // `avoid` is every account the caller has ALREADY tried and seen fail, as a
  // comma-separated list. Excluding just the last one hands a retrying client
  // the same bad accounts again, so the whole tried-set is excluded. If that
  // leaves nothing, the exclusion is dropped rather than failing the vend: a
  // retry on a previously-failing account beats returning no token at all.
  const avoidSet = new Set(
    (url.searchParams.get("avoid") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const model = url.searchParams.get("model");
  const live = accounts.filter((a) => usable(a) && !a.reserve);
  const notTried = live.filter((a) => !avoidSet.has(a.label));
  const usablePool = notTried.length ? notTried : live;
  const order = (pool: typeof usablePool) => {
    const recovered = pool
      .filter((a) => a.rate_limited_at)
      .sort((a, b) => (a.rate_limited_at ?? 0) - (b.rate_limited_at ?? 0));
    const fresh = pool.filter((a) => !a.rate_limited_at);
    const freshRR = fresh.map((_, i) => fresh[(rr + i) % Math.max(fresh.length, 1)]).filter(Boolean);
    return { ordered: [...recovered, ...freshRR], fresh };
  };
  const capable = usablePool.filter((a) => supportsModel(a, model));
  const incapable = usablePool.filter((a) => !supportsModel(a, model));
  const primary = order(capable);
  const fallback = order(incapable);
  const fresh = primary.fresh;
  const ordered = [...primary.ordered, ...fallback.ordered];
  let lastErr = "none";
  for (const acct of ordered) {
    try {
      const out = await tokenFor(acct, force);
      // The account vended cleanly, so its rate limit is behind it. Clearing
      // the marker retires it from the "recovered" queue and returns it to the
      // round-robin. Without this the flag is permanent, recovered accounts
      // always outrank fresh ones, and a single account serves every vend.
      if (acct.rate_limited_at) {
        acct.rate_limited_at = undefined;
        persist();
      }
      if (fresh.length) rr = (rr + 1) % fresh.length; // advance the fresh cursor
      return send(res, 200, out);
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  // Tier 2 (last resort in the broker): the big-budget RESERVE account(s),
  // vended only here and tagged tier="codex-oauth-reserve". After this the VM
  // falls back to its own regular OpenAI key (agent-loop.sh).
  for (const acct of accounts.filter((a) => usable(a) && a.reserve)) {
    try {
      return send(res, 200, { ...(await tokenFor(acct, force)), tier: "codex-oauth-reserve" });
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return send(res, 503, {
    error: accounts.length ? `all accounts failed: ${lastErr}` : "no usable accounts",
    pool_exhausted: true,
  });
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/health") {
      return send(res, 200, { ok: true, accounts: listAccounts().length });
    }
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    // The fleet-wide model allowlist. VMs validate `/model <m>` against this.
    if (url.pathname === "/models") return send(res, 200, { models: ALLOWED_MODELS });
    if (url.pathname === "/accounts") return handleAccounts(req, res, url);
    if (url.pathname === "/rate-limit" && req.method === "POST") return handleRateLimit(res, url);
    if (url.pathname === "/model-unsupported" && req.method === "POST") return handleModelUnsupported(res, url);
    if (url.pathname === "/disable" && req.method === "POST") return handleDisable(res, url);
    if (url.pathname === "/token") return handleToken(res, url);
    return send(res, 404, { error: "not found" });
  });
}
