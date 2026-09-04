import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT, SCAFFOLDING, TOOLS, bashSyntaxOk, pyCompileOk } from "./util";

const read = (p: string) => readFileSync(join(SNAPSHOT, p), "utf8");

describe("vm-base/snapshot - required files", () => {
  const required = [
    "AGENTS.md",
    "problem.md",
    "dependencies.md",
    "notebook.md",
    "handoff.md",
    "verified_math/verified_math.md",
    ".agents/skills/README.md",
    ".agents/skills/gpu-burst/SKILL.md",
    ".agents/skills/cpu-burst/SKILL.md",
    ".agents/skills/web-search/SKILL.md",
    ".agents/skills/research-search/SKILL.md",
    ".agents/skills/lean-search/SKILL.md",
    ".agents/skills/text-operator/SKILL.md",
  ];
  for (const f of required) {
    test(`exists: ${f}`, () => expect(existsSync(join(SNAPSHOT, f))).toBe(true));
  }
  // The snapshot is the agent's context window only: no tool implementations,
  // no memory runtime, no skill scripts/assets. Those live in scaffolding.
  const banned = [
    "tools",
    ".agents/skills/web-search/scripts",
    ".agents/skills/research-search/scripts",
    ".agents/skills/text-operator/scripts",
    ".agents/skills/cpu-burst/assets",
  ];
  for (const f of banned) {
    test(`snapshot does NOT contain: ${f}`, () => expect(existsSync(join(SNAPSHOT, f))).toBe(false));
  }
});

describe("vm-base/snapshot - check_answer stays blank", () => {
  // git does not track empty directories, so in a fresh clone these folders
  // are absent; the provisioner creates them on the VM (sectionSnapshot).
  // Either way they must ship with NO content (no .gitkeep, no placeholder).
  const emptyOrAbsent = (rel: string) =>
    !existsSync(join(SNAPSHOT, rel)) || readdirSync(join(SNAPSHOT, rel)).length === 0;

  test("check_answer/ ships empty - the agent builds it (no .gitkeep, no placeholder)", () => {
    expect(emptyOrAbsent("check_answer")).toBe(true);
  });
  test("verified_math/ starts with only the verified_math.md ledger", () => {
    const entries = readdirSync(join(SNAPSHOT, "verified_math"));
    expect(entries).toEqual(["verified_math.md"]);
  });
  test("workspace/ is at most shared/ + experiments/, both empty (code goes in experiments)", () => {
    if (existsSync(join(SNAPSHOT, "workspace"))) {
      for (const e of readdirSync(join(SNAPSHOT, "workspace"))) {
        expect(["experiments", "shared"]).toContain(e);
      }
    }
    expect(emptyOrAbsent("workspace/shared")).toBe(true);
    expect(emptyOrAbsent("workspace/experiments")).toBe(true);
  });
});

describe("vm-base/scaffolding/tools - agent-callable tool implementations", () => {
  const readTool = (p: string) => readFileSync(join(TOOLS, p), "utf8");
  for (const s of ["setup.sh", "wait.sh", "text_operator.sh"]) {
    test(`${s} is valid, executable bash`, () => {
      expect(bashSyntaxOk(readTool(s)).ok).toBe(true);
      expect((statSync(join(TOOLS, s)).mode & 0o111) !== 0).toBe(true);
    });
  }
  for (const s of ["web_search.py", "research.py", "lean_search.py"]) {
    test(`${s} compiles and is executable`, () => {
      expect(pyCompileOk(readTool(s)).ok).toBe(true);
      expect((statSync(join(TOOLS, s)).mode & 0o111) !== 0).toBe(true);
    });
  }
  test("new-experiment.sh: thin fork (source only) that re-links shared, no git", () => {
    const ne = readTool("new-experiment.sh");
    expect(bashSyntaxOk(ne).ok).toBe(true);
    expect((statSync(join(TOOLS, "new-experiment.sh")).mode & 0o111) !== 0).toBe(true);
    expect(ne).toContain("workspace/experiments");
    expect(ne).toContain("ln -s ../../shared"); // re-links the shared heavy-inputs dir
    // build output is never carried into a fork
    for (const ex of ["target", ".lake", ".venv"]) expect(ne).toContain(ex);
    // it is not git - it must never invoke a git subcommand
    expect(ne).not.toMatch(/\bgit\s+(init|add|commit|push|clone|checkout)\b/);
  });
  test("new-fact.sh: mints sequential ids + frontmatter entry + ledger one-liner (functional)", () => {
    const nf = readTool("new-fact.sh");
    expect(bashSyntaxOk(nf).ok).toBe(true);
    expect((statSync(join(TOOLS, "new-fact.sh")).mode & 0o111) !== 0).toBe(true);
    // run it for real in a throwaway snapshot
    const snap = mkdtempSync(join(tmpdir(), "newfact-"));
    try {
      writeFileSync(join(snap, "problem.md"), "x");
      mkdirSync(join(snap, "verified_math"));
      copyFileSync(join(SNAPSHOT, "verified_math", "verified_math.md"), join(snap, "verified_math", "verified_math.md"));
      const run = (args: string[]) =>
        spawnSync("bash", [join(TOOLS, "new-fact.sh"), ...args], { cwd: snap, encoding: "utf8" });
      expect(run(["Mod 4 Automatism (T18)", "--tier", "lean"]).status).toBe(0);
      expect(run(["dead-family", "--tier", "census", "--negative", "--depends", "F-001"]).status).toBe(0);
      // sequential zero-padded ids, sane slugs
      const dirs = readdirSync(join(snap, "verified_math")).filter((d) => d.startsWith("F-")).sort();
      expect(dirs).toEqual(["F-001_mod-4-automatism-t18", "F-002_dead-family"]);
      // frontmatter is complete and reflects the flags
      const fm = readFileSync(join(snap, "verified_math", "F-002_dead-family", "entry.md"), "utf8");
      expect(fm).toMatch(/^---\nid: F-002\n/);
      expect(fm).toContain("tier: census");
      expect(fm).toContain("polarity: negative");
      expect(fm).toContain("depends_on: [F-001]");
      // ledger got exactly one line per fact
      const ledger = readFileSync(join(snap, "verified_math", "verified_math.md"), "utf8");
      expect(ledger).toContain("- **F-001** [lean] mod-4-automatism-t18:");
      expect(ledger).toContain("- **F-002** [census] dead-family:");
      // refuses to run outside a snapshot root
      expect(spawnSync("bash", [join(TOOLS, "new-fact.sh"), "x"], { cwd: tmpdir(), encoding: "utf8" }).status).not.toBe(0);
    } finally {
      rmSync(snap, { recursive: true, force: true });
    }
  });
  test("setup.sh operates on the agent's cwd (PATH command from the snapshot root)", () => {
    const setup = readTool("setup.sh");
    expect(setup).toContain('ROOT="$(pwd)"');
    expect(setup).not.toContain('cd "$(dirname "$0")/.."');
  });
  test("no submit-done anywhere - text-operator is the only handoff", () => {
    expect(existsSync(join(TOOLS, "submit-done.sh"))).toBe(false);
    // text-operator halts the loop after texting (kills the loop's process group)
    const tc = readTool("text_operator.sh");
    expect(tc).toContain("agent-loop.pid");
    expect(tc).toContain("agent-should-run");
  });
  test("experiment-template: generic rust/cuda/lean skeleton (no Hadamard), Mathlib dep kept", () => {
    const cargo = readTool("experiment-template/rust/Cargo.toml");
    expect(cargo).toContain('name = "experiment"');
    expect(cargo).toContain("[profile.release]");
    const lake = readTool("experiment-template/lean/lakefile.toml");
    expect(lake).toContain('name = "mathlib"');
    const t = [
      readTool("experiment-template/rust/src/main.rs"),
      readTool("experiment-template/cuda/src/search.cu"),
      readTool("experiment-template/lean/Research/Basic.lean"),
    ].join("\n");
    expect(t).not.toMatch(/[Hh]adamard|668/);
  });
  test("cpu-worker template ships with the tools (copied by the cpu-burst grant)", () => {
    expect(readTool("cpu-worker/index.ts")).toContain("getSandbox");
    const wrangler = readTool("cpu-worker/wrangler.jsonc");
    expect(wrangler).toContain('"durable_objects"');
    expect(wrangler).toContain('"nodejs_compat"');
    expect(wrangler).toContain('"instance_type": "standard-4"');
    expect(readTool("cpu-worker/Dockerfile")).toMatch(/FROM docker\.io\/cloudflare\/sandbox:\d+\.\d+\.\d+-python/);
  });
});

describe("vm-base/scaffolding - trigger machinery Pi is blind to", () => {
  const readScaffold = (p: string) => readFileSync(join(SCAFFOLDING, p), "utf8");
  test("contains the supervisor, repl, brokers (+ README)", () => {
    // No codex-activate.py: Codex auth lives in the codex-broker (Railway),
    // never on the VM. The supervisor fetches tokens per turn.
    expect(readdirSync(SCAFFOLDING).sort()).toEqual(
      ["README.md", "agent-loop.sh", "brokers", "reboot-resume.sh", "tabs-repl.sh", "tools"]
    );
    // Brokers follow the repo-wide orchestrator + children/ pattern.
    expect(readdirSync(join(SCAFFOLDING, "brokers")).sort()).toEqual(["children", "orchestrator.py"]);
    expect(readdirSync(join(SCAFFOLDING, "brokers", "children")).sort()).toEqual(["common.py", "cpu.py", "gpu.py"]);
    // Agent-callable tool implementations live here, not in the snapshot.
    expect(readdirSync(join(SCAFFOLDING, "tools")).sort()).toEqual(
      ["cpu-worker", "experiment-template", "lean_search.py", "llm_client.py", "new-experiment.sh", "new-fact.sh", "requirements.txt", "research.py", "setup.sh", "text_operator.sh", "wait.sh", "web_search.py"]
    );
  });
  test("reboot-resume: valid bash, guarded by the should-run intent marker", () => {
    const rr = readScaffold("reboot-resume.sh");
    expect(bashSyntaxOk(rr).ok).toBe(true);
    expect(rr).toContain("agent-should-run");     // only resume if meant to be running
    expect(rr).toContain("RESUME=1 setsid");        // reattach the session, detached
    // repl sets the marker on start, clears it on stop; text-operator clears it on halt
    const repl = readScaffold("tabs-repl.sh");
    expect(repl).toContain('"$SHOULD_RUN"');
    expect(readScaffold("tools/text_operator.sh")).toContain('rm -f "$HOME/.tabs/agent-should-run"');
  });
  test("git is fully retired from the VM: no sync script, no git invocations anywhere", () => {
    expect(existsSync(join(SCAFFOLDING, "github-sync.sh"))).toBe(false);
    // nothing in scaffolding may run a git subcommand (run saves live in R2,
    // driven by the app - the VM never versions anything)
    for (const f of ["agent-loop.sh", "tabs-repl.sh", "reboot-resume.sh"]) {
      expect(readScaffold(f)).not.toMatch(/\bgit\s+(init|add|commit|push|clone|checkout)\b/);
    }
    // saving is not a repl command - the app's Save-to-R2 button drives it
    const repl = readScaffold("tabs-repl.sh");
    expect(repl).not.toContain("save-to-r2");
    expect(repl).toContain("Save to R2"); // ...but the header documents the button
  });
  test("tabs-repl: the loop commands (start-new / stop-loop / start-loop)", () => {
    const repl = readScaffold("tabs-repl.sh");
    expect(bashSyntaxOk(repl).ok).toBe(true);
    expect((statSync(join(SCAFFOLDING, "tabs-repl.sh")).mode & 0o111) !== 0).toBe(true);
    expect(repl).toContain('"/start-new-agent") launch_loop 0');
    expect(repl).toContain('"/stop-recursive-loop") cmd_stop');
    expect(repl).toContain('"/start-recursive-loop") launch_loop 1');
    // the old pre-redesign commands are gone
    for (const dead of ['"/start-agent")', '"/continue-agent")', '"/talk")', '"/status")', '"/help")']) {
      expect(repl).not.toContain(dead);
    }
    expect(repl).toContain("last-session");
    // the supervisor writes that session file and honors RESUME
    const loop = readScaffold("agent-loop.sh");
    expect(loop).toContain("last-session");
    expect(loop).toContain('"${RESUME:-0}" = "1"');
  });
  test("tabs-repl: /model validates against the broker allowlist (fleet-wide rollout)", () => {
    const repl = readScaffold("tabs-repl.sh");
    expect(repl).toContain('"/model"|"/model "*) cmd_model');
    // the allowed models come from the broker's /models endpoint, not hardcoded
    expect(repl).toContain("/models");
    expect(repl).toContain("allowed_models()");
    expect(repl).toContain("agent-model");
    // safe fallback so you're never locked out if the broker is unreachable
    expect(repl).toContain("FALLBACK_MODELS");
    // and the supervisor reads the chosen model fresh each turn
    const loop = readScaffold("agent-loop.sh");
    expect(loop).toContain("resolve_model()");
    expect(loop).toContain("agent-model");
    expect(loop).toMatch(/model="\$\(resolve_model\)"/); // re-read inside run_tier
  });
  test("tabs-repl: loop runs detached with a pid file; stop kills the group then chats", () => {
    const repl = readScaffold("tabs-repl.sh");
    expect(repl).toContain("agent-loop.pid");
    expect(repl).toContain("setsid");
    expect(repl).toContain('kill -TERM -- "-$pid"');
    // stop -> plain text becomes a one-shot chat turn, streamed to the sidebar
    // transcript (not an interactive pi TUI, which the sidebar can't render).
    expect(repl).toContain("cmd_chat");
    expect(repl).toContain('"$sid"'); // chat uses the saved session id
    expect(repl).toContain('python3 "$THINK_PARSER"'); // reply streams into the transcript
  });
  test("supervisor writes + cleans the pid file (the app's edit-lock signal)", () => {
    const loop = readScaffold("agent-loop.sh");
    expect(loop).toContain("agent-loop.pid");
    expect(loop).toContain('echo $$ > "$PIDFILE"');
    expect(loop).toContain('trap \'rm -f "$PIDFILE"\' EXIT');
    expect(loop).toContain("refusing to double-start");
  });
  test("supervisor is valid, executable bash and cwd-driven (not snapshot-relative)", () => {
    const loop = readScaffold("agent-loop.sh");
    expect(bashSyntaxOk(loop).ok).toBe(true);
    expect((statSync(join(SCAFFOLDING, "agent-loop.sh")).mode & 0o111) !== 0).toBe(true);
    expect(loop).toContain('ROOT="$(pwd)"');
    expect(loop).toContain("does not look like a snapshot");
    // Codex tokens come from the broker per turn; nothing codex on disk.
    expect(loop).toContain("broker_token");
    expect(loop).not.toContain("codex-activate");
  });
  test("supervisor implements the 90% handoff→compact trigger", () => {
    const loop = readScaffold("agent-loop.sh");
    expect(loop).toContain("HANDOFF_PCT");
    expect(loop).toContain("rewrite handoff.md");
    expect(loop).toContain("please continue solving the problem");
  });
  test("nothing in the snapshot ships the supervisor (agent must stay blind to it)", () => {
    expect(existsSync(join(SNAPSHOT, "tools/agent-loop.sh"))).toBe(false);
    expect(existsSync(join(SNAPSHOT, "tools/codex-activate.py"))).toBe(false);
  });
});

describe("vm-base - Lean + Mathlib baseline (in the experiment template)", () => {
  const readTpl = (p: string) => readFileSync(join(TOOLS, "experiment-template", p), "utf8");
  test("template lakefile requires Mathlib", () => {
    const lake = readTpl("lean/lakefile.toml");
    expect(lake).toContain('name = "mathlib"');
    expect(lake).toContain("leanprover-community");
  });
  test("template lean-toolchain pins a leanprover/lean4 version", () => {
    expect(readTpl("lean/lean-toolchain")).toMatch(/leanprover\/lean4:/);
  });
  test("setup.sh installs the Lean toolchain (elan); Mathlib is fetched per-experiment", () => {
    const setup = readFileSync(join(TOOLS, "setup.sh"), "utf8");
    expect(setup).toContain("elan");
    // no longer prebuilds a shared lean project
    expect(setup).not.toContain("workspace/shared/lean");
  });
});

describe("vm-base/snapshot - AGENTS.md doctrine", () => {
  const agents = read("AGENTS.md");
  const musts: [string, RegExp][] = [
    ["never stop", /never stop/i],
    ["wait tool", /wait\.sh/],
    ["text-operator is the only handoff/finish", /text-operator/],
    ["build the answer checker first", /check_answer.*first|build this first/i],
    ["negative space", /negative space/i],
    ["verified_math is the source of truth", /verified_math/],
    ["source of truth", /source of truth/i],
    ["one subfolder per verified result", /subfolder per verified result|own subfolder/i],
    ["heart and soul", /heart and soul/i],
    ["elegant structure", /elegant/i],
    ["workspace/ is the working area", /workspace\//],
    ["elastic compute section", /Elastic compute/i],
    ["cpu-burst skill (broker picks the platform)", /cpu-burst request/],
    ["gpu-burst skill (broker picks the platform)", /gpu-burst request/],
    ["provider names hidden from the agent", /^(?![\s\S]*(Cloudflare|E2B|Modal|Daytona))[\s\S]*$/],
    ["mathlib baseline", /Mathlib/],
    ["primary languages rust/cuda/lean", /Rust.*CUDA.*Lean|Rust, CUDA, and Lean/],
    ["please continue re-invoke phrase", /please continue solving the problem/],
    ["runs on Pi (gpt-5.5 xhigh)", /gpt-5\.5 at\s+xhigh|xhigh thinking/i],
    ["context handoff protocol", /handoff\.md/],
    ["zig where they zagged (don't replay the field's failed playbook)", /zig where the(y| field) zagged/i],
  ];
  for (const [name, re] of musts) {
    test(`mentions: ${name}`, () => expect(agents).toMatch(re));
  }
  test("no memora references anywhere in AGENTS.md (memora removed)", () => {
    expect(agents).not.toMatch(/memora/i);
  });
  test("tool commands are referenced bare (on PATH), never under tools/", () => {
    expect(agents).not.toContain("tools/");
  });
});

describe("vm-base/snapshot - problem + ledgers", () => {
  test("problem.md is a fill-in template: just the problem + a solved definition", () => {
    const p = read("problem.md");
    // A placeholder to be filled with the real problem - not a baked-in problem.
    expect(p).toMatch(/The problem is X/i);
    expect(p).toMatch(/definition of "solved"/i);
    // It must stay just the problem - no how-to-solve context bleeds in here
    // (approaches, sub-goals, negative-space doctrine all live in AGENTS.md).
    expect(p).not.toMatch(/negative space|sub-goal|Williamson|approach/i);
  });
  test("verified_math.md is a one-liner ledger over per-fact folders (two-tier memory)", () => {
    const v = read("verified_math/verified_math.md");
    expect(v).toMatch(/ONE LINE per fact/i);
    expect(v).toContain("entry.md"); // full detail lives in each fact's folder
    expect(v).toMatch(/positive \| negative/);
    expect(v).toContain("check_answer");
    expect(v).toMatch(/no `sorry`/i);
    // the frontmatter contract the agent (and new-fact) must follow
    for (const field of ["id:", "tier:", "polarity:", "depends_on:", "supersedes:", "verifier:", "date:"]) {
      expect(v).toContain(field);
    }
    expect(v).toContain("new-fact"); // facts are minted by the tool
    expect(v).toMatch(/never edit or delete/i); // immutability: correct via supersedes
  });
  test("notebook.md is the whole-project dead-end journal", () => {
    expect(read("notebook.md")).toMatch(/dead end/i);
  });
  test("requirements.txt lists core math tools", () => {
    const r = readFileSync(join(TOOLS, "requirements.txt"), "utf8");
    for (const pkg of ["numpy", "sympy"]) expect(r).toContain(pkg);
  });
});

describe("vm-base/snapshot - skills (Pi Agent Skills standard)", () => {
  const SKILLS = [
    "gpu-burst",
    "cpu-burst",
    "web-search",
    "research-search",
    "lean-search",
    "text-operator",
  ];
  for (const name of SKILLS) {
    test(`${name}: frontmatter name matches folder, non-empty description (Pi refuses skills without one)`, () => {
      const skill = read(`.agents/skills/${name}/SKILL.md`);
      const fm = skill.match(/^---\n([\s\S]*?)\n---/);
      expect(fm).not.toBeNull();
      expect(fm![1]).toMatch(new RegExp(`^name: ${name}$`, "m"));
      const desc = fm![1].match(/^description: (.+)$/m);
      expect(desc).not.toBeNull();
      expect(desc![1].length).toBeGreaterThan(20);
      expect(desc![1].length).toBeLessThanOrEqual(1024);
    });
  }
  test("skills that call APIs directly reference their env keys", () => {
    expect(read(".agents/skills/web-search/SKILL.md")).toContain("FIRECRAWL_API_KEY");
    expect(read(".agents/skills/research-search/SKILL.md")).toContain("FIRECRAWL_API_KEY");
  });
  test("burst skills teach ONLY the interface - provider policy stays hidden in the broker", () => {
    for (const s of ["gpu-burst", "cpu-burst"]) {
      const skill = read(`.agents/skills/${s}/SKILL.md`);
      expect(skill).toContain(`${s} request`);
      expect(skill).toContain("status");
      expect(skill).toMatch(/broker/i);
      // no provider-selection policy leaked into the agent-facing contract
      expect(skill).not.toMatch(/modal-1|modal-2|MODAL_TOKEN|first idle|when idle AND/i);
    }
    expect(read(".agents/skills/gpu-burst/SKILL.md")).toMatch(/10 H100/i);
    expect(read(".agents/skills/cpu-burst/SKILL.md")).toContain("400");
  });
});

describe("vm-base/snapshot - skills folder organization ", () => {
  test("skills live ONLY at .agents/skills (no confusing root `skills` alias)", () => {
    // Pi auto-discovers project skills from .agents/skills; we deliberately do
    // not keep a root `skills` symlink - one place, no duplicate tree.
    expect(existsSync(join(SNAPSHOT, ".agents/skills"))).toBe(true);
    expect(existsSync(join(SNAPSHOT, "skills"))).toBe(false);
  });
  test("skills README documents layout + conventions and every skill", () => {
    const readme = read(".agents/skills/README.md");
    for (const name of ["gpu-burst", "cpu-burst", "web-search", "research-search", "lean-search", "text-operator"]) {
      expect(readme).toContain(`${name}/`);
    }
    expect(readme).toMatch(/one folder per skill/i);
    // documents that implementations live in scaffolding, not the snapshot
    expect(readme).toMatch(/scaffolding/i);
  });
  test("every skill folder is JUST a SKILL.md (no scripts/assets in the snapshot)", () => {
    for (const entry of readdirSync(join(SNAPSHOT, ".agents/skills"), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        expect(readdirSync(join(SNAPSHOT, ".agents/skills", entry.name))).toEqual(["SKILL.md"]);
      } else {
        expect(entry.name).toBe("README.md");
      }
    }
  });
  test("search skills document the PATH commands + only-when-necessary doctrine", () => {
    const web = read(".agents/skills/web-search/SKILL.md");
    expect(web).toMatch(/only when/i);
    expect(web).toContain("GPT-5.5");
    expect(web).toContain("web-search "); // the PATH command, not a snapshot path
    expect(web).not.toContain("scripts/");
    const research = read(".agents/skills/research-search/SKILL.md");
    expect(research).toMatch(/only when/i);
    expect(research).toContain("research-search ");
    expect(research).not.toContain("scripts/");
  });
  test("search tool implementations (in scaffolding) digest with GPT-5.5 via the broker chain", () => {
    const llm = readFileSync(join(TOOLS, "llm_client.py"), "utf8");
    expect(llm).toContain('"gpt-5.5"');
    expect(llm).toContain('"xhigh"');
    expect(llm).toContain("chatgpt.com/backend-api/codex/responses"); // tier 1: broker token
    expect(llm).toContain("api.openai.com/v1/responses"); // tier 2: regular key
    expect(llm).toContain("RAILWAY_BROKER_URL");
    const web = readFileSync(join(TOOLS, "web_search.py"), "utf8");
    expect(web).toContain("import llm_client");
    expect(web).not.toMatch(/gemini/i);
    expect(web).toContain("api.firecrawl.dev/v2/search");
    expect(web).toContain("includeDomains");
    const research = readFileSync(join(TOOLS, "research.py"), "utf8");
    expect(research).toContain("api.firecrawl.dev/v2/search/research");
    expect(research).toContain("import llm_client");
    expect(research).not.toMatch(/gemini/i);
    for (const sub of ['"papers"', '"paper"', '"read"', '"similar"', '"github"']) {
      expect(research).toContain(`add_parser(${sub}`);
    }
    for (const mode of ["similar", "citers", "references"]) {
      expect(research).toContain(mode);
    }
  });
  test("text-operator: only the 3 sanctioned cases; texts + HALTS the loop; tags instance id", () => {
    const skill = read(".agents/skills/text-operator/SKILL.md");
    expect(skill).toMatch(/100% stuck/i);
    expect(skill).toMatch(/GPU cluster/i);
    expect(skill).toMatch(/solved/i);            // case 3 = solved (no submit-done anymore)
    expect(skill).toContain("text-operator ");       // the PATH command
    const script = readFileSync(join(TOOLS, "text_operator.sh"), "utf8");
    expect(script).toContain("instance-id");
    expect(script).toContain("[tabs $IID]");
    expect(script).toContain("api.sendblue.co");
    expect(script).toContain("SENDBLUE_API_KEY");
    // after sending, it halts the loop (kills the loop pgid + clears the marker)
    expect(script).toContain("agent-loop.pid");
    expect(script).toContain('kill -TERM -- "-$loop_pid"');
  });
  test("cpu-burst SKILL points at the grant (no snapshot asset path)", () => {
    expect(read(".agents/skills/cpu-burst/SKILL.md")).not.toContain("assets/worker");
  });
});

describe("vm-base/scaffolding - compute brokers (hidden tools)", () => {
  const readScaffold = (p: string) => readFileSync(join(SCAFFOLDING, p), "utf8");
  test("orchestrator + children compile; orchestrator is executable and routes both domains", () => {
    for (const f of [
      "brokers/orchestrator.py",
      "brokers/children/common.py",
      "brokers/children/gpu.py",
      "brokers/children/cpu.py",
    ]) {
      expect(pyCompileOk(readScaffold(f)).ok).toBe(true);
    }
    expect((statSync(join(SCAFFOLDING, "brokers/orchestrator.py")).mode & 0o111) !== 0).toBe(true);
    const orch = readScaffold("brokers/orchestrator.py");
    expect(orch).toContain("ensure_venv()");
    expect(orch).toContain('("gpu", "cpu")');
    expect(orch).toContain("child.run(rest)");
  });
  test("gpu child: daytona → modal-1 → modal-2 order, 10-GPU cap, generic no-capacity", () => {
    const gpu = readScaffold("brokers/children/gpu.py");
    expect(gpu).toContain("MAX_GPUS = 10");
    expect(gpu).toContain("for acct in (1, 2):");
    // daytona is tried first, before the modal accounts
    expect(gpu.indexOf("if daytona_busy() is False:")).toBeLessThan(gpu.indexOf("for acct in (1, 2):"));
    // no-capacity message stays generic (no provider names leaked to the agent)
    expect(gpu).toContain("No GPUs available at this time");
    expect(gpu).not.toContain("FULL: all GPU providers");
  });
  test("cpu child: <=200 vCPU E2B (8/box) else Cloudflare (standard-4), 400 vCPU ceiling", () => {
    const cpu = readScaffold("brokers/children/cpu.py");
    expect(cpu).toContain("VCPU_MAX = 400");
    expect(cpu).toContain("E2B_LIMIT_VCPU = 200");
    expect(cpu).toContain("E2B_VCPU_PER = 8");
    expect(cpu).toContain("CF_VCPU_PER = 4");
    expect(cpu).toContain("vcpu <= E2B_LIMIT_VCPU and e2b_busy() is False");
    expect(cpu).toContain("grant_cloudflare");
    // E2B-error fallback to Cloudflare is surfaced to the agent
    expect(cpu).toContain("cloudflare");
  });
  test("children check LIVE provider state (no shared lock service)", () => {
    const common = readScaffold("brokers/children/common.py");
    expect(common).toContain('"app", "list"'); // modal app list
    expect(common).toContain("Daytona().list()");
    expect(common).toContain("Sandbox.list()");
  });
  test("ensure_venv detects the venv by sys.prefix, NOT realpath(executable)", () => {
    // A venv's bin/python is a symlink to the system python, so realpath()
    // collapses them and ensure_venv would skip the re-exec - running the
    // brokers under system python (no SDKs) so every provider reads
    // 'unavailable' after the venv's first use. Must compare sys.prefix.
    const common = readScaffold("brokers/children/common.py");
    expect(common).toContain("sys.prefix");
    expect(common).toContain("_in_venv()");
    // and the old buggy guard must be gone
    expect(common).not.toContain("os.path.realpath(sys.executable) == os.path.realpath(VENV_PY)");
  });
});
