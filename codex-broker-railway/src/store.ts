// The account pool + its durable backing store.
//
// reserve=true marks the big-budget emergency account: it is EXCLUDED from the
// round-robin and only vended when every regular account is exhausted.
import fs from "node:fs";
import { DATA_DIR, STORE_PATH, RATE_LIMIT_COOLDOWN_MS } from "./config.js";

export interface Account {
  label: string;
  account_id: string;
  refresh_token: string;
  access_token?: string;
  expires_at?: number;
  cooldown_until?: number;
  /** When a VM last reported this account rate-limited (ms). Used to re-admit
   *  the LONGEST-limited accounts first once their cooldown lifts. */
  rate_limited_at?: number;
  dead?: boolean;
  /** Operator-set: account is offline / out of rotation but not discarded.
   *  Unlike a cooldown this never expires; unlike DELETE the tokens are kept. */
  disabled?: boolean;
  last_refresh?: string;
  reserve?: boolean;
  /** Models this account is not entitled to. The Codex backend answers a
   *  request for a model the plan lacks with HTTP 400 rather than an auth
   *  error, so an account can be perfectly healthy and still never serve a
   *  given model. Those accounts are ranked last for that model instead of
   *  being taken out of rotation, since they still serve everything else. */
  unsupported_models?: string[];
}

export interface AccountInput {
  label?: string;
  account_id?: string;
  accountId?: string;
  refresh_token?: string;
  refresh?: string;
  reserve?: boolean;
}

let accounts: Account[] = [];

export function listAccounts(): Account[] {
  return accounts;
}

export function persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    // Volume not mounted (e.g. First boot without a volume): keep running in
    // memory. Rotations then only survive until the next restart.
    console.warn(`[broker] persist failed (${(e as Error).message}); running in-memory`);
  }
}

export function load(): void {
  // The volume is the only store. A fresh boot with an empty volume starts
  // with zero accounts; add them via POST /accounts (push-account.ts).
  try {
    const fromDisk = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (Array.isArray(fromDisk)) {
      accounts = fromDisk;
      console.log(`[broker] loaded ${accounts.length} accounts from ${STORE_PATH}`);
      return;
    }
  } catch {
    /* none yet */
  }
  accounts = [];
  console.log("[broker] no store yet - add accounts via POST /accounts");
}

export function usable(a: Account): boolean {
  return !a.dead && !a.disabled && (!a.cooldown_until || a.cooldown_until < Date.now());
}

/** False only when this account is KNOWN to lack the model. Unknown counts as
 *  supported, so a never-probed account is still tried. */
export function supportsModel(a: Account, model: string | null): boolean {
  if (!model) return true;
  return !(a.unsupported_models || []).includes(model);
}

/** Record that a model is unavailable to this account (the HTTP 400 case).
 *  Returns the account (or null if unknown). Caller persists. */
export function markModelUnsupported(label: string, model: string): Account | null {
  const a = accounts.find((x) => x.label === label);
  if (!a) return null;
  const list = a.unsupported_models || (a.unsupported_models = []);
  if (!list.includes(model)) list.push(model);
  return a;
}

/** Clear a model from an account's unsupported list (e.g. entitlement added). */
export function clearModelUnsupported(label: string, model: string): Account | null {
  const a = accounts.find((x) => x.label === label);
  if (!a) return null;
  a.unsupported_models = (a.unsupported_models || []).filter((m) => m !== model);
  return a;
}

/** Operator toggle: take an account out of rotation (or put it back) without
 *  discarding its tokens. Returns the account (or null if unknown). Caller persists. */
export function setDisabled(label: string, disabled: boolean): Account | null {
  const a = accounts.find((x) => x.label === label);
  if (!a) return null;
  a.disabled = disabled;
  return a;
}

/** A VM hit a usage/rate limit on this account: cool it for ~5h so the broker
 *  skips it until the limit likely eases, then readmits it automatically.
 *  Returns the account (or null if unknown). Caller persists. */
export function markRateLimited(label: string): Account | null {
  const a = accounts.find((x) => x.label === label);
  if (!a) return null;
  const now = Date.now();
  a.rate_limited_at = now;
  a.cooldown_until = now + RATE_LIMIT_COOLDOWN_MS;
  return a;
}

/** Add or refresh an account in place (by label, else account_id). No restart:
 *  it drops straight into the pool that running VMs are already polling.
 *  Caller persists once the batch is applied. */
export function upsertAccount(input: AccountInput): string {
  const label = (input.label || "").trim();
  const account_id = (input.account_id || input.accountId || "").trim();
  const refresh_token = (input.refresh_token || input.refresh || "").trim();
  const reserve = Boolean(input.reserve);
  if (!refresh_token) throw new Error("account needs a refresh_token");
  const existing = accounts.find(
    (a) => (label && a.label === label) || (account_id && a.account_id === account_id)
  );
  if (existing) {
    // Re-seeding a rotated/dead account: replace the token, clear failure flags.
    existing.refresh_token = refresh_token;
    if (account_id) existing.account_id = account_id;
    if ("reserve" in input) existing.reserve = reserve;
    existing.access_token = undefined;
    existing.expires_at = 0;
    existing.cooldown_until = 0;
    existing.dead = false;
    return existing.label;
  }
  const newLabel = label || `account-${accounts.length + 1}`;
  accounts.push({ label: newLabel, account_id, refresh_token, ...(reserve ? { reserve } : {}) });
  return newLabel;
}

/** Remove one account by label. Returns how many were dropped. */
export function removeAccount(label: string | null): number {
  const before = accounts.length;
  accounts = accounts.filter((a) => a.label !== label);
  return before - accounts.length;
}
