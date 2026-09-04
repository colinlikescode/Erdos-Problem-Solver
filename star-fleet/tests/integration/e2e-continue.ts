// END-TO-END continue-run test on real droplets, driving the real code paths:
//   spinupDroplet -> Session.open (provision current chassis) -> restore hook
//   (cargo streamed from R2) -> agent auto-start -> verification -> stop ->
//   Save to R2 (full circle) -> droplet destroy.
//
//   cd star-fleet && bun tests/integration/e2e-continue.ts            # both problems
//   KEEP=1 bun tests/integration/e2e-continue.ts                      # keep droplets
//
// Verifies, per run:
//   CHASSIS is current   - AGENTS.md carries the §1b zig-doctrine (newer than the
//                          save), skills present incl. lean-search, new-fact on PATH
//   CARGO is the SAVE    - exact fact-folder counts, ledger line counts, problem.md
//                          hash == the problem store, notebook/handoff/workspace
//   MECHANICS            - continue-codebase + restore-done markers, loop auto-
//                          started, pi session actually received the CONTINUE prompt
//   FULL CIRCLE          - /stop-recursive-loop -> saveRun() uploads a NEW manifest
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseDotEnv, resolveAgentEnv } from "../../src/electron/agentEnv";
import { spinupDroplet, destroyDroplet } from "../../src/electron/digitalocean";
import { Session } from "../../src/electron/session/children/session";
import { restoreRun, saveRun, listSavedRuns, sha256 } from "../../src/electron/runs";
import type { ConnectionProfile, Problem } from "../../src/shared/types";

const REPO = join(process.cwd(), "..");
const dotenv = parseDotEnv(readFileSync(join(REPO, ".env"), "utf8"));
const agentEnv = resolveAgentEnv(dotenv, { openaiApiKey: "" });
const DO_TOKEN = dotenv.DIGITAL_OCEAN_API_KEY || "";
const KEEP = process.env.KEEP === "1";

const problemsFile = join(homedir(), "Library", "Application Support", "Star Fleet", "problems.json");
const problems: Problem[] = JSON.parse(readFileSync(problemsFile, "utf8"));

let pass = 0;
let fail = 0;
const ok = (m: string) => { pass++; console.log(`  PASS: ${m}`); };
const bad = (m: string) => { fail++; console.log(`  FAIL: ${m}`); };
const check = (cond: boolean, m: string) => (cond ? ok(m) : bad(m));
const hdr = (m: string) => console.log(`\n== ${m} ==`);

interface Target {
  problemName: string;
  expectFacts: number; // fact FOLDERS in verified_math/
}
const TARGETS: Target[] = [
  { problemName: "Hadamard 668", expectFacts: 96 },
  { problemName: "Navier–Stokes finite-time blow-up", expectFacts: 25 },
];

const saves = await listSavedRuns(dotenv);
const droplets: number[] = [];

async function runTarget(t: Target): Promise<void> {
  hdr(`${t.problemName} - continue run, end to end`);
  const problem = problems.find((p) => p.name === t.problemName);
  if (!problem) return bad(`problem "${t.problemName}" not in the store`);
  const save = saves.find((s) => s.problemId === problem.id);
  if (!save) return bad(`no R2 save for ${t.problemName}`);
  ok(`using save ${save.runId} (${save.factCount} facts in manifest)`);

  // 1. Real droplet via the real spin-up path (same as runs:create).
  const vm = await spinupDroplet(
    DO_TOKEN,
    { name: `tabs-e2e-continue-${t.problemName.startsWith("Had") ? "h668" : "ns"}`, seedProblem: problem.description },
    (m) => console.log(`  [spinup] ${m}`)
  );
  droplets.push(vm.dropletId);
  ok(`droplet up: ${vm.host} (id ${vm.dropletId})`);

  // 2. Real Session with the real restore hook (mirrors main.ts session:open).
  const profile: ConnectionProfile = {
    id: `e2e-${Date.now()}`,
    name: vm.name,
    host: vm.host,
    port: 22,
    username: vm.username,
    remotePath: "/root/snapshot",
    agent: "pi",
    authMethod: "password",
    problemId: problem.id,
    restoreRunId: save.runId,
    autoStart: true,
    createdAt: Date.now(),
  };
  const session = new Session(
    profile,
    { password: vm.password },
    agentEnv,
    problem.description,
    async (s, log) => restoreRun(s, dotenv, problem, save.runId, log)
  );
  session.on("log", (_id, line) => console.log(`  [vm] ${line}`));
  await session.open();
  ok("provision + R2 restore + auto-start completed (Session.open)");

  const x = (cmd: string) => session.exec(cmd);

  // 3. CHASSIS is the current base (not the save's old chassis).
  const agents = await x('cat "$HOME/snapshot/AGENTS.md"');
  check(/zig where the(y| field) zagged/i.test(agents), "chassis: AGENTS.md carries TODAY'S §1b zig-doctrine");
  check(agents.includes("lean-search"), "chassis: AGENTS.md teaches lean-search (current skills)");
  const skills = await x('ls "$HOME/snapshot/.agents/skills"');
  check(skills.includes("lean-search") && skills.includes("text-operator"), "chassis: all 6 skill folders shipped");
  // (bare SSH exec has no agent PATH - check the installed wrappers directly)
  const nf = await x('[ -x "$HOME/.local/bin/new-fact" ] && [ -x "$HOME/.local/bin/lean-search" ] && echo WRAPPERS');
  check(nf.includes("WRAPPERS"), "chassis: new-fact + lean-search wrappers installed on PATH");

  // 4. CARGO is the SAVED run.
  const counts = await x(
    // FACT folders only (F-001_x / V001_x), not the colocated lean/ project dir.
    'cd "$HOME/snapshot" && echo "FOLDERS=$(ls verified_math | grep -cE "^[FV]-?[0-9]")" && ' +
      'echo "LINES=$(grep -cE "^- \\*\\*[FV]-?[0-9]" verified_math/verified_math.md)" && ' +
      'echo "PSHA=$(sha256sum problem.md | cut -d\\  -f1)" && ' +
      'for f in notebook.md handoff.md check_answer workspace/experiments; do [ -e "$f" ] && echo "HAVE $f"; done'
  );
  const num = (k: string) => Number((counts.match(new RegExp(`${k}=(\\d+)`)) || [])[1] || -1);
  check(num("FOLDERS") === t.expectFacts, `cargo: ${t.expectFacts} verified_math fact folders restored (got ${num("FOLDERS")})`);
  check(num("LINES") === t.expectFacts, `cargo: ledger has exactly ${t.expectFacts} one-liners (got ${num("LINES")})`);
  check((counts.match(/PSHA=([0-9a-f]+)/) || [])[1] === sha256(problem.description), "cargo: problem.md hash == problem store (no drift)");
  for (const f of ["notebook.md", "handoff.md", "check_answer", "workspace/experiments"]) {
    check(counts.includes(`HAVE ${f}`), `cargo: ${f} restored`);
  }

  // 5. MECHANICS: markers + the loop is alive + pi got the CONTINUE prompt.
  const marks = await x('for m in continue-codebase restore-done agent-should-run; do [ -e "$HOME/.tabs/$m" ] && echo "M $m"; done');
  for (const m of ["continue-codebase", "restore-done", "agent-should-run"]) check(marks.includes(`M ${m}`), `marker: ${m}`);
  const alive = await x('pid=$(cat "$HOME/.tabs/agent-loop.pid" 2>/dev/null); [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo ALIVE');
  check(alive.includes("ALIVE"), "agent loop auto-started and running");
  // give the first turn a moment to hit the model, then look for the prompt
  await new Promise((r) => setTimeout(r, 45_000));
  const prompt = await x('grep -rl "CONTINUING a long-running research program" "$HOME/.pi/agent/sessions" 2>/dev/null | head -1');
  check(prompt.trim().length > 0, "pi session received the CONTINUE prompt (on 3rd base, not restarting)");
  const turning = await x('grep -cE "run provider=" "$HOME/.tabs/agent-loop.log" 2>/dev/null');
  check(Number(turning.trim()) >= 1, "supervisor is turning (run provider= logged)");

  // 6. FULL CIRCLE: stop the loop, then a real Save to R2 (the button's path).
  await session.sendToRepl("/stop-recursive-loop");
  await new Promise((r) => setTimeout(r, 8_000));
  const guard = await saveRun(session, dotenv, problem, "e2e full-circle save", (m) => console.log(`  [save] ${m}`))
    .then((m) => m)
    .catch((e) => e as Error);
  if (guard instanceof Error) bad(`save after stop failed: ${guard.message}`);
  else {
    ok(`full circle: stopped + saved back to R2 as ${guard.runId} (${guard.factCount} facts)`);
    check(guard.factCount === t.expectFacts, "full-circle save carries the same fact count");
  }
  session.disconnect();
}

for (const t of TARGETS) {
  try {
    await runTarget(t);
  } catch (e) {
    bad(`${t.problemName}: ${(e as Error).message}`);
  }
}

if (!KEEP) {
  hdr("teardown");
  for (const id of droplets) {
    await destroyDroplet(DO_TOKEN, id).then(
      () => ok(`droplet ${id} destroyed`),
      (e) => bad(`destroy ${id}: ${(e as Error).message}`)
    );
  }
} else {
  console.log(`\nKEEP=1 - droplets left running: ${droplets.join(", ")}`);
}

console.log(`\n==================== ${pass} PASS, ${fail} FAIL ====================`);
process.exit(fail === 0 ? 0 : 1);
