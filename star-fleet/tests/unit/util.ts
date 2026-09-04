// Shared helpers for the unit/integration tests.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** star-fleet root - bun test runs with cwd at star-fleet/. */
export const ROOT = process.cwd();
/** Repo root: star-fleet/ and vm-base/ live side by side. */
export const REPO = join(ROOT, "..");
/** The snapshot forked onto each VM (agent's working world). */
export const SNAPSHOT = join(REPO, "vm-base", "snapshot");
/** The trigger scaffolding installed outside the agent's workspace. */
export const SCAFFOLDING = join(REPO, "vm-base", "scaffolding");
/** Agent-callable tool implementations (installed on PATH from scaffolding). */
export const TOOLS = join(SCAFFOLDING, "tools");

/** Run `bash -n` (syntax check only) on a script string. */
export function bashSyntaxOk(script: string): { ok: boolean; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "tabs-bash-"));
  try {
    const f = join(dir, "s.sh");
    writeFileSync(f, script);
    const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
    return { ok: r.status === 0, err: r.stderr || "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compile-check a Python source string with `python3 -m py_compile`. */
export function pyCompileOk(code: string): { ok: boolean; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "tabs-py-"));
  try {
    const f = join(dir, "m.py");
    writeFileSync(f, code);
    const r = spawnSync("python3", ["-m", "py_compile", f], { encoding: "utf8" });
    return { ok: r.status === 0, err: r.stderr || "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Decode a base64 blob the script writes via inline `echo '<b64>' | base64 -d > "…dest"`. */
export function extractB64Write(script: string, destSuffix: string): string {
  const esc = destSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("echo '([A-Za-z0-9+/=]+)' \\| base64 -d > \"[^\"]*" + esc + '"');
  const m = script.match(re);
  if (!m) throw new Error("base64 write not found for " + destSuffix);
  return Buffer.from(m[1], "base64").toString("utf8");
}

/** Decode a base64 value assigned to a shell var: `VAR='<b64>'`. */
export function extractShellVarB64(script: string, varName: string): string {
  const m = script.match(new RegExp(varName + "='([A-Za-z0-9+/=]*)'"));
  if (!m) throw new Error("shell var not found: " + varName);
  return m[1] ? Buffer.from(m[1], "base64").toString("utf8") : "";
}

/** Build a fake JWT (header.payload.sig) with an arbitrary payload. */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(payload)}.sig`;
}

/** Build a base64 Codex `auth.json` blob like the ones in `.env`/`tokens.txt`. */
export function fakeCodexBlobB64(
  opts: { exp?: number; account_id?: string; refresh?: string; access?: string } = {}
): string {
  const access = opts.access ?? fakeJwt({ exp: opts.exp ?? 1_900_000_000 });
  const blob = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({}),
      access_token: access,
      refresh_token: opts.refresh ?? "rt.test.token",
      account_id: opts.account_id ?? "acc-123",
    },
  };
  return Buffer.from(JSON.stringify(blob)).toString("base64");
}
