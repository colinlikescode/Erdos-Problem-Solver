// Token mechanics for a single account: refresh against OpenAI, and vend a
// cached-or-fresh access token. Refreshes are serialized per account.
import { TOKEN_URL, CLIENT_ID, REFRESH_SKEW_MS, COOLDOWN_MS } from "./config.js";
import { persist, type Account } from "./store.js";

export interface VendedToken {
  tier: string;
  access_token: string;
  account_id: string;
  label: string;
  expires_at: number;
}

// --- per-account async lock: never refresh the same account concurrently
// (concurrent refresh = double rotation = one of them invalidated).
const locks = new Map<string, Promise<unknown>>();
function withLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(label) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(label, next.catch(() => {}));
  return next;
}

async function refresh(acct: Account): Promise<Account> {
  // Byte-identical to Pi's own openai-codex refresh (form-encoded, no scope)  - 
  // we are impersonating the official client's refresh, nothing more.
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: acct.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    // invalid_grant = the refresh chain is broken (rotated elsewhere / revoked).
    if (res.status === 400 || /invalid_grant/i.test(text)) {
      acct.dead = true;
      persist(); // remember across restarts - don't hammer a broken chain
      throw new Error(`account ${acct.label} needs re-login (${res.status}: ${text.slice(0, 120)})`);
    }
    acct.cooldown_until = Date.now() + COOLDOWN_MS;
    persist();
    throw new Error(`refresh ${acct.label} failed (${res.status}: ${text.slice(0, 120)})`);
  }
  const data = JSON.parse(text);
  acct.access_token = data.access_token;
  if (data.refresh_token) acct.refresh_token = data.refresh_token; // capture rotation
  acct.expires_at = Date.now() + Number(data.expires_in || 3600) * 1000;
  acct.last_refresh = new Date().toISOString();
  acct.cooldown_until = 0;
  acct.dead = false;
  persist(); // durably keep the rotated refresh token
  return acct;
}

/** Return a valid (cached or freshly refreshed) access token for one account.
 *  force=true skips the cache - used when a caller got 401 token_invalidated
 *  (ChatGPT revokes outstanding access tokens on logout/new-login events, so a
 *  cached token can die long before its expiry). */
export async function tokenFor(acct: Account, force = false): Promise<VendedToken> {
  return withLock(acct.label, async () => {
    const fresh =
      !force && acct.access_token && acct.expires_at && acct.expires_at - Date.now() > REFRESH_SKEW_MS;
    if (!fresh) await refresh(acct);
    return {
      tier: "codex-oauth",
      access_token: acct.access_token as string,
      account_id: acct.account_id,
      label: acct.label,
      expires_at: acct.expires_at as number,
    };
  });
}
