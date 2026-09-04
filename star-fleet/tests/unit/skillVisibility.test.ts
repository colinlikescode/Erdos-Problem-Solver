import { test, expect, describe, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProvisionScript, agentStartCommand } from "../../src/electron/provision/orchestrator";

/**
 * Can the agent actually SEE its skills? This test exercises the real shipped
 * artifact, not the repo layout: it builds the production provision script,
 * extracts the base64 snapshot tarball embedded in it (exactly what lands at
 * ~/snapshot on a VM), untars it, and verifies the full discovery chain Pi
 * depends on:
 *
 *   1. Pi runs with cwd = ~/snapshot (the supervisor uses $(pwd); tabs-repl is
 *      started with `cd <folder>`), and auto-discovers project skills from
 *      <cwd>/.agents/skills/<name>/SKILL.md.
 *   2. Each SKILL.md must have frontmatter Pi accepts: `name` matching the
 *      folder and a non-empty `description` (Pi refuses skills without one).
 *   3. Every command a SKILL.md teaches must actually exist on the agent's
 *      PATH - installed by the same provision script (~/.local/bin wrappers),
 *      with ~/.local/bin exported on PATH in the agent env.
 */

const FULL_ENV = {
  RAILWAY_BROKER_URL: "https://broker.example",
  RAILWAY_BROKER_API_KEY: "brk-x",
  OPENAI_REGULAR_API_KEY: "sk-proj-REG",
  GEMINI_API_KEY: "AQ.gemini",
  RAILWAY_LEAN_SEARCH_URL: "https://lean.example",
  RAILWAY_LEAN_SEARCH_API_KEY: "ls-x",
  E2B_API_KEY: "e2b_x",
  CLOUDFLARE_ACCOUNT_ID: "cf-acct",
  CLOUDFLARE_API_KEY: "cfat_x",
  DAYTONA_API_KEY: "dtn_x",
  MODAL_TOKEN_ID_1: "ak-1",
  MODAL_TOKEN_SECRET_1: "as-1",
  MODAL_TOKEN_ID_2: "ak-2",
  MODAL_TOKEN_SECRET_2: "as-2",
  FIRECRAWL_API_KEY: "fc-x",
  SENDBLUE_API_KEY: "sb-key",
  SENDBLUE_API_SECRET: "sb-secret",
  GITHUB_TOKEN: "ghp_testtoken",
  GITHUB_ORG: "star-fleet-math",
};

// The six skills the agent must see, and the PATH command each one teaches.
const EXPECTED_SKILLS: Record<string, string> = {
  "gpu-burst": "gpu-burst",
  "cpu-burst": "cpu-burst",
  "web-search": "web-search",
  "research-search": "research-search",
  "lean-search": "lean-search",
  "text-operator": "text-operator",
};

let script = "";
let shipped = ""; // temp dir holding the UNTARRED shipped snapshot
let skillsDir = "";

beforeAll(() => {
  script = buildProvisionScript("pi", FULL_ENV, "/home/ubuntu/snapshot");

  // Pull the snapshot tarball out of the provision script - the exact bytes a
  // VM receives - and unpack it like sectionSnapshot does (tar -xzf - -C $HOME).
  const m = script.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d \| tar -xzf - -C "\$HOME"/);
  if (!m) throw new Error("snapshot tarball not found in the provision script");
  shipped = mkdtempSync(join(tmpdir(), "shipped-snapshot-"));
  const tgz = join(shipped, "snap.tgz");
  writeFileSync(tgz, Buffer.from(m[1], "base64"));
  execFileSync("tar", ["-xzf", tgz, "-C", shipped]);
  skillsDir = join(shipped, "snapshot", ".agents", "skills");
});

describe("skill visibility - the shipped snapshot puts skills where Pi looks", () => {
  test("~/snapshot/.agents/skills/ exists in the shipped tarball", () => {
    expect(existsSync(skillsDir)).toBe(true);
  });

  test("every expected skill folder ships, and nothing unexpected", () => {
    const folders = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(folders).toEqual(Object.keys(EXPECTED_SKILLS).sort());
  });

  test("each shipped SKILL.md has frontmatter Pi accepts (name == folder, real description)", () => {
    for (const name of Object.keys(EXPECTED_SKILLS)) {
      const p = join(skillsDir, name, "SKILL.md");
      expect(existsSync(p)).toBe(true);
      const fm = readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
      expect(fm).not.toBeNull();
      // Pi matches the frontmatter name; a mismatch or missing description
      // makes the skill invisible/refused.
      expect(fm![1]).toMatch(new RegExp(`^name: ${name}$`, "m"));
      const desc = fm![1].match(/^description: (.+)$/m);
      expect(desc).not.toBeNull();
      expect(desc![1].trim().length).toBeGreaterThan(20);
      expect(desc![1].length).toBeLessThanOrEqual(1024);
    }
  });

  test("each shipped SKILL.md actually mentions the command it teaches", () => {
    for (const [name, cmd] of Object.entries(EXPECTED_SKILLS)) {
      const skill = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
      expect(skill).toContain(cmd);
    }
  });
});

describe("skill visibility - every taught command is runnable from the agent's shell", () => {
  test("the SAME provision script installs a ~/.local/bin wrapper for every skill command", () => {
    for (const cmd of Object.values(EXPECTED_SKILLS)) {
      expect(script).toContain(`.local/bin/${cmd}`);
      expect(script).toContain(`chmod +x "$HOME/.local/bin/${cmd}"`);
    }
  });

  test("~/.local/bin is on the PATH the agent env exports", () => {
    expect(script).toMatch(/export PATH="\$HOME\/\.local\/bin:/);
  });
});

describe("skill visibility - Pi's cwd is the snapshot root (where discovery happens)", () => {
  test("the agent tmux session starts in the snapshot folder", () => {
    // sectionStartAgent embeds `cd <folder>; … tabs-repl.sh` - cwd IS the
    // snapshot root, so <cwd>/.agents/skills is exactly what shipped above.
    expect(script).toContain("cd /home/ubuntu/snapshot");
    expect(agentStartCommand("pi")).toContain("tabs-repl.sh");
  });

  test("the supervisor derives the snapshot root from its cwd (not its own location)", () => {
    const loop = script.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d > "[^"]*agent-loop\.sh\.new"/);
    expect(loop).not.toBeNull();
    const src = Buffer.from(loop![1], "base64").toString("utf8");
    expect(src).toContain('ROOT="$(pwd)"');
  });
});
