import { test, expect, describe } from "bun:test";
import { buildProvisionScript, agentStartCommand, agentTmux } from "../../src/electron/provision/orchestrator";
import { bashSyntaxOk, extractShellVarB64, extractB64Write } from "./util";

const FULL_ENV = {
  RAILWAY_BROKER_URL: "https://broker.example",
  RAILWAY_BROKER_API_KEY: "brk-x",
  OPENAI_REGULAR_API_KEY: "sk-proj-REG",
  GEMINI_API_KEY: "AQ.gemini",
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

describe("agentTmux / agentStartCommand", () => {
  test("tmux session name is tabs-pi", () => {
    expect(agentTmux("pi")).toBe("tabs-pi");
  });
  test("agent start drops into tabs-repl (no auto-start; user types /start-new-agent)", () => {
    const cmd = agentStartCommand("pi");
    expect(cmd).toContain("$HOME/.tabs/scaffolding/tabs-repl.sh");
    expect(cmd).toContain("else pi");
    expect(cmd).not.toContain("agent-loop.sh"); // the run must NOT auto-start
    expect(cmd).not.toContain('"'); // embedded in double-quoted tmux args
  });
});

describe("buildProvisionScript - bash validity", () => {
  test("valid bash with full env", () => {
    expect(bashSyntaxOk(buildProvisionScript("pi", FULL_ENV, "/home/ubuntu")).ok).toBe(true);
  });
  test("valid bash with empty env", () => {
    expect(bashSyntaxOk(buildProvisionScript("pi", {}, "/home/ubuntu")).ok).toBe(true);
  });
  test("valid bash with a spaced folder path", () => {
    expect(bashSyntaxOk(buildProvisionScript("pi", {}, "/home/ub untu/p")).ok).toBe(true);
  });
  test("exactly one `set -e`", () => {
    expect(buildProvisionScript("pi", FULL_ENV, "/home/ubuntu").match(/^set -e$/gm)?.length).toBe(1);
  });
});

describe("buildProvisionScript - installs Pi, not OpenCode", () => {
  const s = buildProvisionScript("pi", FULL_ENV, "/home/ubuntu");
  test("installs Pi + the Codex account extension (no MCP - Pi has none)", () => {
    expect(s).toContain("@earendil-works/pi-coding-agent");
    expect(s).toContain("pi-codex-account");
    // The Codex PAT provider is deprecated and fully removed.
    expect(s).not.toContain("pi-codex-token");
    expect(s).not.toContain("pi-mcp-extension");
  });
  test("no OpenCode / Claude / Cursor left", () => {
    expect(s).not.toContain("opencode");
    expect(s).not.toContain("opencode-claude-auth");
    expect(s).not.toContain("open-cursor");
    expect(s).not.toContain("cursor-acp");
  });
  test("phase markers + tmux start + ready", () => {
    for (const m of ["checking Pi", "tmux new-session", "[tabs] ready"]) expect(s).toContain(m);
  });
  test("tmux closes fd 9 so the daemon never inherits the provision lock", () => {
    // Otherwise the long-lived tmux server holds flock(9) forever and the next
    // provision (reconnect/reopen) blocks. Both tmux spawns must have `9>&-`.
    expect(s).toMatch(/tmux new-session -d -s \S+ "[^"]*" 2>\/dev\/null 9>&-/);
    expect(s).toMatch(/tmux new-session -d -s \S+ 9>&-/);
  });
  test("installs Node when npm is missing (not just when node is missing)", () => {
    // DO/Ubuntu images ship node without npm; guarding on node alone left Pi uninstalled.
    expect(s).toContain("! command -v npm");
    expect(s).toContain("install -y npm");
  });
});

describe("buildProvisionScript - Pi settings (compaction + trust)", () => {
  const s = buildProvisionScript("pi", FULL_ENV, "/home/ubuntu");
  test("merges settings.json with compaction + trust (preserves pi packages)", () => {
    const settings = JSON.parse(extractShellVarB64(s, "PI_SETTINGS_B64"));
    expect(settings.compaction.enabled).toBe(true);
    expect(settings.defaultProjectTrust).toBe("always");
    // merge, not overwrite - must not clobber the `packages` pi install records
    expect(s).toContain("...cur");
  });
});

describe("buildProvisionScript - OpenAI auth (broker-first; nothing codex on disk)", () => {
  const s = buildProvisionScript("pi", FULL_ENV, "/home/ubuntu");
  test("NO codex credentials are seeded on the VM (the broker owns all chains)", () => {
    // The old accounts-store seeding (ACCOUNTS_B64/codex-accounts.json)
    // is gone for good: locally stored refresh tokens go stale on the broker's
    // first rotation and can break the chain. Do not resurrect it.
    expect(s).not.toContain("ACCOUNTS_B64");
    expect(s).not.toContain("codex-accounts.json");
    expect(s).not.toContain("codex-activate");
  });
  test("broker coordinates are exported for the supervisor's tier 1", () => {
    expect(s).toContain("export RAILWAY_BROKER_URL='https://broker.example'");
    expect(s).toContain("export RAILWAY_BROKER_API_KEY='brk-x'");
  });
  test("regular key threaded in as PI_REGULAR_KEY + exported as OPENAI_API_KEY", () => {
    expect(s).toContain("PI_REGULAR_KEY='sk-proj-REG'");
    expect(s).toContain("export OPENAI_API_KEY='sk-proj-REG'");
    // The deprecated Codex PAT must never be exported.
    expect(s).not.toContain("CODEX_ACCESS_TOKEN");
  });
  test("codex OAuth blobs are NOT exported into the agent env file", () => {
    expect(s).not.toContain("OPENAI_CODEX_AUTH_JSON_B64");
  });
  test("skill provider keys are exported for the snapshot skills", () => {
    for (const line of [
      "export E2B_API_KEY='e2b_x'",
      "export CLOUDFLARE_ACCOUNT_ID='cf-acct'",
      "export CLOUDFLARE_API_KEY='cfat_x'",
      "export DAYTONA_API_KEY='dtn_x'",
      "export MODAL_TOKEN_ID_1='ak-1'",
      "export MODAL_TOKEN_SECRET_2='as-2'",
      "export FIRECRAWL_API_KEY='fc-x'",
      "export SENDBLUE_API_KEY='sb-key'",
      "export SENDBLUE_API_SECRET='sb-secret'",
    ]) {
      expect(s).toContain(line);
    }
  });
  test("provision mints a per-VM instance id for notification tagging", () => {
    expect(s).toContain("instance-id");
  });
  test("provision installs the trigger scaffolding outside the workspace (atomic writes)", () => {
    expect(s).toContain("agent scaffolding");
    expect(s).toContain(".tabs/scaffolding");
    // temp-file + mv so a running supervisor is never corrupted mid-read
    expect(s).toContain("agent-loop.sh.new");
    expect(s).toMatch(/mv -f .*agent-loop\.sh/);
    // the shipped supervisor is the real one from vm-base/scaffolding
    const shipped = extractB64Write(s, "agent-loop.sh.new");
    expect(shipped).toContain("HANDOFF_PCT");
    expect(shipped).toContain('ROOT="$(pwd)"');
  });
  test("provision ships tabs-repl (the human command surface) into scaffolding", () => {
    const repl = extractB64Write(s, "tabs-repl.sh.new");
    expect(repl).toContain("/start-new-agent");
    expect(repl).toContain("/stop-recursive-loop");
    expect(repl).toContain("/start-recursive-loop");
  });
  test("provision installs the reboot-resume hook + @reboot cron", () => {
    expect(s).toContain("reboot-resume.sh.new");
    expect(s).toContain("@reboot");
    expect(s).toContain("reboot-resume.sh");
  });
  test("git/GitHub is fully retired: no sync install, creds never shipped, legacy scrubbed", () => {
    expect(s).not.toContain("github-sync.sh.new");
    expect(s).not.toContain("GITHUB_TOKEN");
    expect(s).not.toContain("ghp_testtoken"); // even with a token in .env, it never reaches a VM
    // older VMs get the retired machinery removed
    expect(s).toContain('rm -f "$HOME/.tabs/scaffolding/tools/submit-done.sh"'); // (pattern held)
    expect(s).toContain("github-sync.sh");
    expect(s).toContain('rm -rf "$HOME/.tabs/snapshot-git"');
  });
  test("provision places the snapshot at ~/snapshot exactly once (never clobbers)", () => {
    expect(s).toContain('if [ ! -d "$HOME/snapshot" ]');
    expect(s).toContain("placing research snapshot");
    expect(s).toContain("snapshot already present");
    // the tarball is real: contains the base64 of a gzip stream (H4sI…)
    expect(s).toMatch(/base64 -d \| tar -xzf - -C "\$HOME"/);
    expect(s).toContain("'H4sI");
  });
  test("first placement creates the empty working folders git cannot track", () => {
    expect(s).toContain(
      'mkdir -p "$HOME/snapshot/check_answer" "$HOME/snapshot/workspace/shared" "$HOME/snapshot/workspace/experiments"'
    );
    expect(s.indexOf("tar -xzf")).toBeLessThan(s.indexOf('mkdir -p "$HOME/snapshot/check_answer"'));
  });
  test("no seed problem => problem.md is NOT written (only the edit hint mentions it)", () => {
    expect(s).not.toContain('> "$HOME/snapshot/problem.md"');
  });
  test("a seed problem writes problem.md into the fresh snapshot", () => {
    const seeded = buildProvisionScript("pi", FULL_ENV, "/home/ubuntu/snapshot", "SOLVE X = 42");
    const seedB64 = Buffer.from("SOLVE X = 42").toString("base64");
    expect(seeded).toContain(`echo '${seedB64}' | base64 -d > "$HOME/snapshot/problem.md"`);
    expect(seeded.indexOf("tar -xzf")).toBeLessThan(seeded.indexOf("snapshot/problem.md"));
  });
  test("provision installs the broker orchestrator + children and the burst wrappers on PATH", () => {
    for (const f of [
      "brokers/orchestrator.py.new",
      "brokers/children/common.py.new",
      "brokers/children/gpu.py.new",
      "brokers/children/cpu.py.new",
    ]) {
      expect(s).toContain(f);
    }
    // the wrappers route through the orchestrator with a domain prefix
    expect(s).toContain('.local/bin/gpu-burst"');
    expect(s).toContain('.local/bin/cpu-burst"');
    expect(s).toContain('brokers/orchestrator.py" gpu "$@"');
    expect(s).toContain('brokers/orchestrator.py" cpu "$@"');
    const gpu = extractB64Write(s, "children/gpu.py.new");
    expect(gpu).toContain("MAX_GPUS = 10");
    const cpu = extractB64Write(s, "children/cpu.py.new");
    expect(cpu).toContain("VCPU_MAX = 400");
  });
  test("installs the agent-callable tools into scaffolding + PATH wrappers", () => {
    const s = buildProvisionScript("pi", FULL_ENV, "/home/ubuntu/snapshot");
    // implementations written under scaffolding/tools
    for (const f of [
      "tools/setup.sh.new",
      "tools/wait.sh.new",
      "tools/web_search.py.new",
      "tools/research.py.new",
      "tools/lean_search.py.new",
      "tools/llm_client.py.new",
      "tools/text_operator.sh.new",
      "tools/new-experiment.sh.new",
      "tools/new-fact.sh.new",
      "tools/cpu-worker/index.ts.new",
      "tools/experiment-template/rust/Cargo.toml.new",
      "tools/experiment-template/lean/lakefile.toml.new",
    ]) {
      expect(s).toContain(f);
    }
    // each is exposed as a bare command on PATH (implementation stays in scaffolding)
    for (const cmd of ["setup.sh", "wait.sh", "web-search", "research-search", "lean-search", "text-operator", "new-experiment", "new-fact"]) {
      expect(s).toContain(`.local/bin/${cmd}`);
    }
    // submit-done is gone - text-operator is the only handoff. No atomicWrite of it
    // and no PATH wrapper; the provisioner only removes any stale copy.
    expect(s).not.toContain("submit-done.sh.new");
    expect(s).not.toContain(`cat > "$HOME/.local/bin/submit-done.sh"`);
    expect(s).toContain('rm -f "$HOME/.tabs/scaffolding/tools/submit-done.sh"'); // stale cleanup
    expect(s).toContain("scaffolding/tools/web_search.py");
    // the actual implementations shipped (spot-check content survives the b64 round-trip)
    expect(extractB64Write(s, "tools/web_search.py.new")).toContain("import llm_client");
    expect(extractB64Write(s, "tools/llm_client.py.new")).toContain("chatgpt.com/backend-api/codex/responses");
    expect(extractB64Write(s, "tools/experiment-template/rust/Cargo.toml.new")).toContain("[profile.release]");
  });
});

describe("buildProvisionScript - no Memora (removed)", () => {
  test("provision script contains no memora machinery", () => {
    const s = buildProvisionScript("pi", FULL_ENV, "/home/ubuntu");
    expect(s).not.toMatch(/memora/i);
    expect(s).not.toContain("CHROMA_API_KEY");
  });
});
