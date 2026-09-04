// Push the account currently logged into the local Codex CLI to the live
// broker. This is the way to add or fix a Codex account (there is no other):
//
//   rm -f ~/.codex/auth.json            # never `codex logout` - it revokes the
//                                       # server-side session and kills the
//                                       # broker's refresh chain for that account
//   codex login --device-auth           # sign in as the target account
//   npm run push-account -- account-3   # push it under that label
//   npm run push-account -- codex-reserve --reserve   # the big-budget reserve
//
// Reads RAILWAY_BROKER_URL + RAILWAY_BROKER_API_KEY from the repo-root .env. Re-pushing an
// existing label replaces its refresh token and clears dead/cooldown flags
// (that's how a `needs-relogin` account is recovered). After pushing, the
// broker owns the chain - never use the local CLI with that account again.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const label = process.argv[2];
const reserve = process.argv.includes("--reserve");
if (!label) {
  console.error("usage: npm run push-account -- <label> [--reserve]   (e.g. account-3, codex-reserve)");
  process.exit(1);
}

// Compiled to dist/push-account.js - the repo-root .env is two levels up.
const env = fs.readFileSync(path.join(import.meta.dirname, "..", "..", ".env"), "utf8");
const envVal = (k: string): string => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1].trim() || "";
const url = envVal("RAILWAY_BROKER_URL");
const key = envVal("RAILWAY_BROKER_API_KEY");
if (!url || !key) {
  console.error("RAILWAY_BROKER_URL / RAILWAY_BROKER_API_KEY missing from .env");
  process.exit(1);
}

const authPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");
const tokens = JSON.parse(fs.readFileSync(authPath, "utf8")).tokens || {};
if (!tokens.refresh_token) {
  console.error(`${authPath} has no refresh_token - run \`codex login --device-auth\` first`);
  process.exit(1);
}

// Show which account this is (email lives in the id_token JWT) as a sanity check.
try {
  const payload = tokens.id_token.split(".")[1];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  console.error(`pushing ${claims.email || "?"} (${tokens.account_id}) as "${label}"${reserve ? " [RESERVE]" : ""}`);
} catch {
  console.error(`pushing account_id ${tokens.account_id} as "${label}"${reserve ? " [RESERVE]" : ""}`);
}

const res = await fetch(`${url.replace(/\/$/, "")}/accounts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify({
    label,
    account_id: tokens.account_id || "",
    refresh_token: tokens.refresh_token,
    ...(reserve ? { reserve: true } : {}),
  }),
});
console.error(`POST /accounts → ${res.status}: ${await res.text()}`);
if (res.ok) {
  // Verify the broker can actually refresh the chain (force bypasses cache).
  const vend = await fetch(`${url.replace(/\/$/, "")}/token?account=${label}&force=1`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const body = await vend.json();
  console.error(body.access_token ? `verify: ${label} refreshed + vended OK` : `verify FAILED: ${JSON.stringify(body)}`);
  process.exit(body.access_token ? 0 : 1);
}
process.exit(1);
