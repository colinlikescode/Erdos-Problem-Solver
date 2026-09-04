import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCAFFOLDING, TOOLS } from "./util";

/**
 * Drive the scaffolding supervisor with a stub `pi` on PATH for a few seconds
 * and check the log. Mirrors production: the supervisor lives OUTSIDE the
 * snapshot workdir (~/.tabs/scaffolding on real VMs) and is started with
 * cwd = the snapshot root. With no Codex accounts store and only
 * OPENAI_API_KEY set, it falls straight to the regular-key tier and loops
 * there - enough to prove it re-invokes with the right flags/prompts.
 */
function runLoop(
  seconds: number,
  opts: {
    piStub?: string;
    before?: (work: string) => void;
    /** Extra env for the supervisor (e.g. RAILWAY_BROKER_URL). */
    extraEnv?: Record<string, string>;
    /** Stub the `curl` binary (fakes the codex-broker). */
    curlStub?: string;
  } = {}
): { log: string; work: string; signal: string | null } {
  const dir = mkdtempSync(join(tmpdir(), "loop-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const work = join(dir, "work");
  const scaffold = join(dir, "scaffolding"); // outside the workdir, like prod
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(scaffold, { recursive: true });
  mkdirSync(join(work, "tools"), { recursive: true });

  for (const f of ["AGENTS.md", "problem.md", "notebook.md"]) writeFileSync(join(work, f), "x");
  mkdirSync(join(work, "verified_math"), { recursive: true });
  writeFileSync(join(work, "verified_math", "verified_math.md"), "x");
  copyFileSync(join(SCAFFOLDING, "agent-loop.sh"), join(scaffold, "agent-loop.sh"));
  chmodSync(join(scaffold, "agent-loop.sh"), 0o755);

  // Stub pi: echo args + a small token count (json mode) so the supervisor's
  // context-usage parse works and stays well under the handoff threshold.
  const stub = join(bin, "pi");
  writeFileSync(
    stub,
    opts.piStub ?? '#!/usr/bin/env bash\necho "PI: $*"\necho \'{"usage":{"input":100},"totalTokens":100}\'\nexit 0\n'
  );
  chmodSync(stub, 0o755);
  if (opts.curlStub) {
    writeFileSync(join(bin, "curl"), opts.curlStub);
    chmodSync(join(bin, "curl"), 0o755);
  }
  opts.before?.(work);

  const log = join(dir, "loop.log");
  const r = spawnSync("bash", ["-c", `cd "${work}" && exec "${scaffold}/agent-loop.sh"`], {
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      AGENT_LOG: log,
      OPENAI_API_KEY: "sk-test",
      ...(opts.extraEnv || {}),
    },
    encoding: "utf8",
    timeout: seconds * 1000,
    killSignal: "SIGKILL",
  });
  return { log: existsSync(log) ? readFileSync(log, "utf8") : "", work, signal: r.signal };
}

describe("agent-loop.sh - never-stop supervisor (Pi)", () => {
  const { log } = runLoop(9);

  test("invokes Pi repeatedly (re-invoke on turn end)", () => {
    expect((log.match(/run provider=openai/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  test("first turn bootstraps, later turns say 'please continue solving the problem'", () => {
    expect((log.match(/start solving/g) || []).length).toBe(1);
    expect((log.match(/please continue solving the problem/g) || []).length).toBeGreaterThanOrEqual(1);
  });
  test("invokes pi in json mode with gpt-5.5:xhigh on the openai provider", () => {
    expect(log).toMatch(/PI: --session-id \S+ -p --mode json --provider openai --model gpt-5\.5:xhigh/);
  });
  test("logs the failover intent + handoff threshold", () => {
    expect(log).toContain("failover: broker pool+reserve -> regular OpenAI key");
    expect(log).toContain("handoff at 90%");
    expect(log).toContain("model=gpt-5.5:xhigh");
  });
  test("openai (raw API) tier uses the 1M window for gpt-5.5", () => {
    // The harness only sets OPENAI_API_KEY, so every turn runs on the openai
    // tier - the effective window must be the raw-API 1,000,000, not the
    // Codex-backend 400k.
    expect(log).toMatch(/run provider=openai model=gpt-5\.5:xhigh window=1000000/);
  });
  test("refuses to start when cwd is not a snapshot (no problem.md)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-guard-"));
    const scaffold = join(dir, "scaffolding");
    mkdirSync(scaffold, { recursive: true });
    copyFileSync(join(SCAFFOLDING, "agent-loop.sh"), join(scaffold, "agent-loop.sh"));
    chmodSync(join(scaffold, "agent-loop.sh"), 0o755);
    const r = spawnSync("bash", ["-c", `cd "${dir}" && "${scaffold}/agent-loop.sh"`], {
      env: { HOME: dir, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not look like a snapshot");
  });
});

describe("agent-loop.sh - broker tier (codex-broker wired in)", () => {
  // Fake the broker with a curl stub; the pi stub prints the openai-codex
  // access token it finds in auth.json so we can prove the vended token is
  // written there and drives pi's ChatGPT-account provider (openai-codex).
  const { log } = runLoop(8, {
    extraEnv: { RAILWAY_BROKER_URL: "http://broker.test", RAILWAY_BROKER_API_KEY: "brk-test" },
    curlStub:
      "#!/usr/bin/env bash\n" +
      'echo \'{"tier":"codex-oauth","access_token":"vended-token-abc","account_id":"acc-1","label":"account-1","expires_at":9999999999999}\'\n',
    piStub:
      "#!/usr/bin/env bash\n" +
      'AT=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser(\\"~/.pi/agent/auth.json\\")))[\\"openai-codex\\"][\\"access\\"])" 2>/dev/null)\n' +
      'echo "PI: $* AUTHTOKEN=$AT"\n' +
      "echo '{\"totalTokens\":100}'\nexit 0\n",
  });

  test("broker tier runs FIRST on the openai-codex provider (ChatGPT-account)", () => {
    expect(log).toContain("tier=broker account=account-1 (codex-oauth)");
    expect(log).toMatch(/run provider=openai-codex model=gpt-5\.5:xhigh/);
    expect(log).toMatch(/PI: --session-id \S+ -p --mode json --provider openai-codex --model gpt-5\.5:xhigh/);
  });
  test("the vended token is written to auth.json as the openai-codex credential", () => {
    expect(log).toContain("AUTHTOKEN=vended-token-abc");
  });
  test("same context protocol on this tier (first prompt bootstraps)", () => {
    expect((log.match(/start solving/g) || []).length).toBe(1);
  });
  test("codex-backend tier uses the 400k window (matches observed capacity)", () => {
    expect(log).toMatch(/run provider=openai-codex model=gpt-5\.5:xhigh window=400000/);
  });
});

describe("agent-loop.sh - classifies pi's error, NOT the agent's text", () => {
  // A SUCCESSFUL turn whose output/tool-results happen to contain "rate limit"
  // and "context length" (the agent researching errors) must not trigger a
  // failover or a compaction. Only pi's structured error drives those.
  const { log } = runLoop(9, {
    piStub:
      "#!/usr/bin/env bash\n" +
      'echo "PI: $*"\n' +
      // tool-result-shaped line with scary words, but the turn stops cleanly:
      "echo '{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"error: API rate limit exceeded; maximum context length reached; 401 unauthorized\"}]}}'\n" +
      "echo '{\"type\":\"turn_end\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"stop\",\"usage\":{\"totalTokens\":1000}}}'\n" +
      "exit 0\n",
  });
  test("does not fail over on scary words inside a successful turn", () => {
    expect(log).not.toContain("unavailable (rate-limit/auth); advancing");
    expect(log).not.toContain("context overflow");
    // and it keeps running normally (multiple successful re-invokes)
    expect((log.match(/run provider=openai/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  test("logs the turn as ec=0 (success) despite the scary tool text", () => {
    expect(log).toMatch(/tokens=1000 ec=0/);
  });
});

describe("agent-loop.sh - context overflow compacts instead of failing over", () => {
  // pi returns a context-length error -> the supervisor must compact (handoff ->
  // fresh session) and stay on the same provider, not burn accounts.
  const { log } = runLoop(9, {
    piStub:
      "#!/usr/bin/env bash\n" +
      'echo "PI: $*"\n' +
      // every turn reports a context-length error -> the supervisor should keep
      // choosing to compact (not fail over) for the whole run.
      "echo '{\"type\":\"error\",\"errorMessage\":\"context_length_exceeded: prompt is too long\"}'\n" +
      "exit 0\n",
  });
  test("detects the overflow and compacts (writes handoff.md, fresh session)", () => {
    expect(log).toContain("context overflow");
    expect(log).toContain("compacting");
    expect(log).toMatch(/writing handoff\.md/);
  });
  test("does NOT advance/fail over the provider on overflow", () => {
    expect(log).not.toContain("unavailable (rate-limit/auth); advancing");
  });
});

describe("agent-loop.sh - model switch (gpt-5.4 vs gpt-5.5)", () => {
  // The pi stub echoes the --model it was invoked with; the supervisor should
  // use whatever ~/.tabs/agent-model says, re-read each turn.
  const piEchoModel =
    "#!/usr/bin/env bash\n" + 'echo "PI: $*"\n' + "echo '{\"totalTokens\":100}'\nexit 0\n";

  test(
    "defaults to gpt-5.5:xhigh when no model file is set",
    () => {
      const { log } = runLoop(7, { piStub: piEchoModel });
      expect(log).toMatch(/--model gpt-5\.5:xhigh/);
    },
    20000
  );
  test(
    "honors ~/.tabs/agent-model (gpt-5.4) written before start",
    () => {
      const { log } = runLoop(7, {
        piStub: piEchoModel,
        before: (work) => {
          // ~/.tabs is under HOME = <dir>/home; work is <dir>/work.
          const home = join(work, "..", "home", ".tabs");
          mkdirSync(home, { recursive: true });
          writeFileSync(join(home, "agent-model"), "gpt-5.4:xhigh\n");
        },
      });
      expect(log).toMatch(/--model gpt-5\.4:xhigh/);
      expect(log).not.toMatch(/--model gpt-5\.5/);
      expect(log).toContain("model=gpt-5.4:xhigh");
    },
    20000
  );
});

describe("agent-loop.sh - no memora machinery (removed)", () => {
  test("the supervisor contains no memora references", () => {
    const src = readFileSync(join(SCAFFOLDING, "agent-loop.sh"), "utf8");
    expect(src).not.toMatch(/memora/i);
  });
});

describe("agent-loop.sh - broker down falls through to regular key", () => {
  const { log } = runLoop(8, {
    extraEnv: { RAILWAY_BROKER_URL: "http://broker.test", RAILWAY_BROKER_API_KEY: "brk-test" },
    // curl fails (broker unreachable) -> supervisor must fall to tier 3.
    curlStub: "#!/usr/bin/env bash\nexit 7\n",
  });
  test("falls through to the openai tier instead of stalling", () => {
    expect(log).toContain("tier=openai (regular key)");
    expect(log).toMatch(/run provider=openai model=gpt-5\.5:xhigh/);
  });
});

describe("reboot-resume.sh - restart the loop after a reboot (2-week safety)", () => {
  // Simulate a post-reboot boot: no running loop, a snapshot present, and the
  // intent marker deciding whether to auto-restart. Uses a stub pi so the
  // restarted loop is fast; REBOOT_RESUME_DELAY=0 skips the settle sleep.
  function bootWith(opts: { shouldRun: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "reboot-"));
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    const snap = join(home, "snapshot");
    const scaffold = join(home, ".tabs", "scaffolding");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(snap, "tools"), { recursive: true });
    mkdirSync(join(snap, "verified_math"), { recursive: true });
    mkdirSync(scaffold, { recursive: true });
    mkdirSync(join(home, ".tabs"), { recursive: true });
    for (const t of ["agent-loop.sh", "reboot-resume.sh"]) {
      copyFileSync(join(SCAFFOLDING, t), join(scaffold, t));
      chmodSync(join(scaffold, t), 0o755);
    }
    for (const f of ["AGENTS.md", "problem.md", "notebook.md"]) writeFileSync(join(snap, f), "x");
    writeFileSync(join(snap, "verified_math", "verified_math.md"), "x");
    writeFileSync(join(bin, "pi"), '#!/usr/bin/env bash\necho \'{"totalTokens":100}\'\nexit 0\n');
    chmodSync(join(bin, "pi"), 0o755);
    if (opts.shouldRun) writeFileSync(join(home, ".tabs", "agent-should-run"), "");
    // no ~/.tabs-agent.env - keep PATH so our stub pi wins
    spawnSync("bash", [join(scaffold, "reboot-resume.sh")], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, REBOOT_RESUME_DELAY: "0" },
      encoding: "utf8",
      timeout: 8000,
    });
    const log = join(home, ".tabs", "agent-loop.log");
    const out = existsSync(log) ? readFileSync(log, "utf8") : "";
    // stop whatever it started so the temp dir can be cleaned
    const pidf = join(home, ".tabs", "agent-loop.pid");
    if (existsSync(pidf)) {
      const pid = readFileSync(pidf, "utf8").trim();
      if (pid) spawnSync("bash", ["-c", `kill -TERM -- -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`]);
    }
    rmSync(dir, { recursive: true, force: true });
    return out;
  }

  test("auto-restarts when the intent marker is set (was actively running)", () => {
    const out = bootWith({ shouldRun: true });
    expect(out).toContain("restarting the never-stop loop after a reboot");
  });
  test("does NOT restart when there is no intent marker (deliberately stopped / escalated)", () => {
    const out = bootWith({ shouldRun: false });
    expect(out).not.toContain("restarting the never-stop loop");
  });
});

describe("wait.sh - sanctioned pause", () => {
  test("waits ~N seconds and prints reason + resume", () => {
    const start = Date.now();
    const r = spawnSync("bash", [join(TOOLS, "wait.sh"), "1", "unit test reason"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("unit test reason");
    expect(r.stdout).toContain("resuming");
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });
});
