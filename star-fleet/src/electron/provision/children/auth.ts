import { shellSingleQuote } from "./shell";

/** Pi global settings: compaction (context management) + project trust. */
export const PI_SETTINGS = JSON.stringify(
  {
    // Auto-compaction keeps a days-long session from overflowing; the supervisor
    // also runs an explicit handoff-then-reset protocol near the limit.
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    // Headless VMs: trust the forked snapshot's AGENTS.md / project files.
    defaultProjectTrust: "always",
  },
  null,
  2
);

/**
 * Seed Pi's OpenAI auth (~/.pi/agent/auth.json) with the regular API key only.
 *
 * Codex ChatGPT accounts are deliberately not seeded here: the codex-broker
 * (Railway) is the single owner of every Codex refresh chain - OpenAI rotates
 * refresh tokens on every refresh, so any locally-stored copy goes stale the
 * moment the broker refreshes. The supervisor (vm-base/scaffolding/
 * agent-loop.sh) fetches short-lived access tokens from the broker per turn
 * and writes them into Pi's native `openai-codex` credential.
 * A legacy `codex-accounts.json` seeding path used to exist;
 * do not resurrect it.
 */
export function sectionPiAuth(regularKey: string): string {
  return `
mkdir -p "$HOME/.pi/agent"
PI_REGULAR_KEY=${shellSingleQuote(regularKey)} node -e '
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = path.join(os.homedir(), ".pi", "agent");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const authPath = path.join(dir, "auth.json");
  let auth = {};
  try { auth = JSON.parse(fs.readFileSync(authPath, "utf8")); } catch {}
  const rk = process.env.PI_REGULAR_KEY || "";
  if (rk) auth.openai = { type: "api_key", key: rk };
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
' && echo "[tabs] Pi OpenAI auth ready" || echo "[tabs] warning: pi auth seed failed"`;
}
