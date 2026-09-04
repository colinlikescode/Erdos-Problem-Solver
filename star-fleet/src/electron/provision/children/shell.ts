import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentKind } from "../../../shared/types";
import { SKILL_PROVIDER_KEYS } from "../../agentEnv";

/** Base64-encode for safe transport inside the provision script. */
export function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** Single-quote a value for safe embedding inside the provision shell script. */
export function shellSingleQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/** The agent's tmux session name - persists independently of the SSH session. */
export function agentTmux(agent: AgentKind): string {
  return `tabs-${agent}`;
}

/**
 * The command the agent's tmux session runs: drop into the tabs-repl
 * (scaffolding). The autonomous run does not auto-start - the user sets up
 * problem.md, then /start-new-agent (/stop-recursive-loop pauses + chats;
 * /start-recursive-loop resumes). Falls back to interactive Pi if the
 * scaffolding is missing. NOTE: no double quotes here - the command is embedded
 * inside double-quoted tmux args (paths contain no spaces).
 */
export function agentStartCommand(_agent: AgentKind): string {
  return (
    "if [ -x $HOME/.tabs/scaffolding/tabs-repl.sh ]; " +
    "then $HOME/.tabs/scaffolding/tabs-repl.sh; else pi; fi"
  );
}

/**
 * Tar+gzip+base64 the whole research snapshot (vm-base/snapshot/) at
 * provision-build time, so the provision script can place it on the VM in its
 * own dedicated folder. Returns "" if the
 * snapshot folder can't be found (provision then skips snapshot placement).
 */
export function snapshotTarB64(): string {
  const candidates = [
    path.join(process.cwd(), "..", "vm-base"), // cwd = star-fleet/
    path.join(process.cwd(), "vm-base"), // cwd = repo root
    path.join(__dirname, "..", "..", "..", "..", "..", "..", "vm-base"),
    path.join(__dirname, "..", "..", "..", "..", "..", "vm-base"),
  ];
  for (const dir of candidates) {
    try {
      if (!fs.existsSync(path.join(dir, "snapshot", "AGENTS.md"))) continue;
      const tar = execFileSync("tar", ["-czf", "-", "-C", dir, "snapshot"], {
        maxBuffer: 64 * 1024 * 1024,
      });
      return tar.toString("base64");
    } catch {
      /* try next */
    }
  }
  return "";
}

/**
 * Load a VM-side asset from `vm-base/<subdir>/<name>` (the scaffolding
 * runtime and the scaffolding the provisioner installs on each VM). The assets
 * live in the image folder because they RUN on the VM; the star fleet only
 * ships them. Resolved against a few candidate roots so it works in
 * `bun run dev` (cwd = star-fleet/), `electron .`, and a packaged build.
 */
export function readImageAsset(subdir: string, name: string): string {
  const rel = ["vm-base", subdir, name];
  const candidates = [
    path.join(process.cwd(), "..", ...rel), // cwd = star-fleet/
    path.join(process.cwd(), ...rel), // cwd = repo root
    // Walk up from the compiled location
    // (star-fleet/dist-electron/src/electron/provision/children).
    path.join(__dirname, "..", "..", "..", "..", "..", "..", ...rel),
    path.join(__dirname, "..", "..", "..", "..", "..", ...rel),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  return "";
}

/**
 * Env exports for the agent, sourced whenever it starts. Maps the resolved keys
 * to what Pi + its extensions expect. Codex ChatGPT accounts are not here  - 
 * the supervisor fetches those tokens from the codex-broker per turn.
 */
export function agentEnvExports(env: Record<string, string>): string {
  const lines: string[] = [];
  if (env.OPENAI_REGULAR_API_KEY) {
    // Pi's built-in `openai` provider reads OPENAI_API_KEY (final fallback).
    lines.push(`export OPENAI_API_KEY=${shellSingleQuote(env.OPENAI_REGULAR_API_KEY)}`);
  }
  if (env.GEMINI_API_KEY) {
    lines.push(`export GEMINI_API_KEY=${shellSingleQuote(env.GEMINI_API_KEY)}`);
  }
  // The codex-broker: the supervisor fetches per-turn Codex access tokens from
  // it (pool -> reserve, decided broker-side) and writes them into Pi's native
  // openai-codex credential.
  for (const k of ["RAILWAY_BROKER_URL", "RAILWAY_BROKER_API_KEY"] as const) {
    if (env[k]) lines.push(`export ${k}=${shellSingleQuote(env[k])}`);
  }
  // The lean-search service - the `lean-search` skill reads these from the env.
  for (const k of ["RAILWAY_LEAN_SEARCH_URL", "RAILWAY_LEAN_SEARCH_API_KEY"] as const) {
    if (env[k]) lines.push(`export ${k}=${shellSingleQuote(env[k])}`);
  }
  // Elastic compute + search providers for the snapshot skills (E2B, Cloudflare,
  // Modal x2, Daytona, Firecrawl). The skills read these from the agent env.
  for (const k of SKILL_PROVIDER_KEYS) {
    if (env[k]) lines.push(`export ${k}=${shellSingleQuote(env[k])}`);
  }
  return lines.join("\n");
}
