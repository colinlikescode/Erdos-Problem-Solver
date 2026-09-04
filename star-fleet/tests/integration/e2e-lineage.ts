// real-VM lineage test: continue Navier–Stokes from its NEWEST save (itself a
// child of the seed import), let the agent take a turn, save again - then
// prove the R2 manifests now form a three-generation tree with every
// continuation in its own runs/<problemId>/<runId>/ folder.
//
//   cd star-fleet && bun tests/integration/e2e-lineage.ts   (KEEP=1 keeps the droplet)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseDotEnv, resolveAgentEnv } from "../../src/electron/agentEnv";
import { spinupDroplet, destroyDroplet } from "../../src/electron/digitalocean";
import { Session } from "../../src/electron/session/children/session";
import { restoreRun, saveRun, listSavedRuns } from "../../src/electron/runs";
import { buildSaveTree, flattenSaveTree } from "../../src/shared/saveTree";
import type { ConnectionProfile, Problem } from "../../src/shared/types";

const REPO = join(process.cwd(), "..");
const dotenv = parseDotEnv(readFileSync(join(REPO, ".env"), "utf8"));
const agentEnv = resolveAgentEnv(dotenv, { openaiApiKey: "" });
const DO_TOKEN = dotenv.DIGITAL_OCEAN_API_KEY || "";
const KEEP = process.env.KEEP === "1";

let pass = 0;
let fail = 0;
const ok = (msg: string) => { pass++; console.log(`  PASS: ${msg}`); };
const bad = (msg: string) => { fail++; console.log(`  FAIL: ${msg}`); };
const check = (c: boolean, msg: string) => (c ? ok(msg) : bad(msg));

const problems: Problem[] = JSON.parse(
  readFileSync(join(homedir(), "Library", "Application Support", "Star Fleet", "problems.json"), "utf8")
);
const problem = problems.find((p) => p.name === "Navier–Stokes finite-time blow-up")!;

const before = (await listSavedRuns(dotenv, problem.id)).sort((a, b) => b.savedAt - a.savedAt);
const tip = before[0]; // newest save = the e2e full-circle child
console.log(`continuing from tip save ${tip.runId} (parent=${tip.parentRunId ?? "ROOT"})`);
check(Boolean(tip.parentRunId), "tip save already has a parent (generation 2)");

let dropletId = 0;
try {
  const vm = await spinupDroplet(DO_TOKEN, { name: "tabs-e2e-lineage-ns", seedProblem: problem.description }, (m) =>
    console.log(`  [spinup] ${m}`)
  );
  dropletId = vm.dropletId;
  ok(`droplet up: ${vm.host}`);

  const profile: ConnectionProfile = {
    id: `e2e-lineage-${Date.now()}`,
    name: vm.name,
    host: vm.host,
    port: 22,
    username: vm.username,
    remotePath: "/root/snapshot",
    agent: "pi",
    authMethod: "password",
    problemId: problem.id,
    restoreRunId: tip.runId,
    autoStart: true,
    createdAt: Date.now(),
  };
  const session = new Session(profile, { password: vm.password }, agentEnv, problem.description, (s, log) =>
    restoreRun(s, dotenv, problem, tip.runId, log)
  );
  session.on("log", (_id, line) => console.log(`  [vm] ${line}`));
  await session.open();
  ok("provision + restore-from-tip + auto-start completed");

  const parentOnVm = (await session.exec('cat "$HOME/.tabs/parent-run" 2>/dev/null')).trim();
  check(parentOnVm === tip.runId, `VM remembers its parent save (${parentOnVm})`);

  // Let the agent take (part of) a first turn, then stop + save.
  await new Promise((r) => setTimeout(r, 60_000));
  await session.sendToRepl("/stop-recursive-loop");
  await new Promise((r) => setTimeout(r, 8_000));
  const saved = await saveRun(session, dotenv, problem, "lineage e2e - generation 3", (m) =>
    console.log(`  [save] ${m}`)
  );
  check(saved.parentRunId === tip.runId, `new save records parentRunId == the save it grew from`);
  check(saved.runId !== tip.runId, "new save landed in its OWN R2 folder (new runId)");
  session.disconnect();

  // The tree: seed -> e2e-child -> this save (three generations, one branch).
  const after = await listSavedRuns(dotenv, problem.id);
  const rows = flattenSaveTree(buildSaveTree(after));
  console.log("\n  lineage tree as the UI renders it:");
  for (const { node } of rows) {
    console.log(`  ${"   ".repeat(node.depth)}${node.depth > 0 ? "└─ " : "●  "}${node.manifest.runId}  (${node.manifest.factCount} facts${node.manifest.note ? `, ${node.manifest.note}` : ""})`);
  }
  // The new save must sit exactly one level below the tip it continued from  - 
  // however deep the chain already is (this test may have run before).
  const tipRow = rows.find((r) => r.node.manifest.runId === tip.runId);
  const newRow = rows.find((r) => r.node.manifest.runId === saved.runId);
  check(
    newRow != null && tipRow != null && newRow.node.depth === tipRow.node.depth + 1,
    `tree extends the lineage: new save is one level below its parent (depth ${newRow?.node.depth} = tip ${tipRow?.node.depth} + 1)`
  );
  check(newRow != null && newRow.node.depth >= 2, "chain is at least three generations deep");
  check(new Set(after.map((s) => s.runId)).size === after.length, "every save has its own unique R2 folder");
} catch (e) {
  bad((e as Error).message);
} finally {
  if (dropletId && !KEEP) {
    await destroyDroplet(DO_TOKEN, dropletId).then(
      () => ok(`droplet ${dropletId} destroyed`),
      (e) => bad(`destroy failed: ${(e as Error).message}`)
    );
  }
}

console.log(`\n==================== ${pass} PASS, ${fail} FAIL ====================`);
process.exit(fail === 0 ? 0 : 1);
