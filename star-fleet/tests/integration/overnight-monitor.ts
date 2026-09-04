// Monitor the overnight fleet (from /tmp/overnight-vms.json). One pass = SSH
// each VM and capture: loop alive, turn count, verified_math folder count,
// last error, disk %, notebook tail, and a COMPREHENSION check (did the agent's
// first turn read problem.md / AGENTS.md and state what it's doing?). Flags
// anomalies (loop dead, no turns, repeated errors, stall, disk pressure).
//
//   bun tests/integration/overnight-monitor.ts            # one pass
//   bun tests/integration/overnight-monitor.ts --watch 15 # loop every 15 min
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "../../src/electron/session/children/connection";
import type { Client } from "ssh2";

const VMS_FILE = "/tmp/overnight-vms.json";
const LOG = "/tmp/overnight-monitor.log";

interface Vm {
  problemName: string;
  host: string;
  password: string;
  dropletId: number;
  startedAt: number;
}

function exec(conn: Client, cmd: string): Promise<string> {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve(`ERR ${err.message}`);
      let out = "";
      stream.on("data", (d: Buffer) => (out += d));
      stream.stderr.on("data", () => {});
      stream.on("close", () => resolve(out));
    });
  });
}

function say(line: string) {
  console.log(line);
  appendFileSync(LOG, line + "\n");
}

async function probe(vm: Vm): Promise<void> {
  const ageMin = Math.round((Date.now() - vm.startedAt) / 60000);
  let conn: Client;
  try {
    conn = await connect(vm.host, 22, "root", { password: vm.password });
  } catch (e) {
    say(`  ⛔ [${vm.problemName}] UNREACHABLE (${(e as Error).message}) - droplet ${vm.dropletId}`);
    return;
  }
  try {
    const info = await exec(
      conn,
      'L=$(cat "$HOME/.tabs/agent-loop.pid" 2>/dev/null); ' +
        'if [ -n "$L" ] && kill -0 "$L" 2>/dev/null; then echo "LOOP=alive"; else echo "LOOP=dead"; fi; ' +
        '[ -f "$HOME/.tabs/agent-should-run" ] && echo "SHOULDRUN=yes" || echo "SHOULDRUN=no"; ' +
        'echo "TESCALATION=$(grep -oE \'case (solved|stuck|gpu)\' "$HOME/.tabs/agent-thinking.jsonl" 2>/dev/null | tail -1)"; ' +
        'echo "TURNS=$(grep -cE \'run provider=\' "$HOME/.tabs/agent-loop.log" 2>/dev/null)"; ' +
        'echo "FACTS=$(ls "$HOME/snapshot/verified_math" 2>/dev/null | grep -cE \'^[FV]-?[0-9]\')"; ' +
        'echo "ERRS=$(grep -cE \'turn exit=[1-9]|FAILED\' "$HOME/.tabs/agent-loop.log" 2>/dev/null)"; ' +
        'echo "DISK=$(df -P / | awk \'NR==2{print $5}\')"; ' +
        'echo "CHKDIR=$(ls "$HOME/snapshot/check_answer" 2>/dev/null | wc -l | tr -d " ")"; ' +
        'echo "LASTLOG=$(tail -c 240 "$HOME/.tabs/agent-loop.log" 2>/dev/null | tr \'\\n\' \' \' | tail -c 180)"'
    );
    const g = (k: string) => (info.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim() ?? "?";
    const loopAlive = g("LOOP") === "alive";
    const shouldRun = g("SHOULDRUN") === "yes";
    const tescalation = g("TESCALATION"); // "case solved" | "case stuck" | "case gpu" | ""
    const turns = Number(g("TURNS")) || 0;
    const facts = g("FACTS");
    const disk = g("DISK");

    // Classify: solved+halt and escalate+halt are DESIGNED terminal states
    // (text-operator clears agent-should-run). A dead loop that was still meant to
    // run is the only real crash.
    let status: string;
    if (loopAlive) status = "🟢 running";
    else if (!shouldRun && tescalation.includes("solved")) status = "✅ SOLVED (halted for human)";
    else if (!shouldRun && (tescalation.includes("stuck") || tescalation.includes("gpu")))
      status = `🟡 ESCALATED (${tescalation}) - needs human`;
    else if (!shouldRun) status = "✅ halted (stopped intentionally)";
    else status = "⛔ CRASH - loop dead but should-run set";

    const flags: string[] = [];
    if (ageMin > 15 && turns === 0 && loopAlive) flags.push("NO TURNS YET");
    if (Number(disk.replace("%", "")) >= 90) flags.push(`DISK ${disk}`);
    say(
      `  [${vm.problemName}] ${status}${flags.length ? " ⚠ " + flags.join(", ") : ""} | ` +
        `age ${ageMin}m | turns=${turns} facts=${facts} checker=${g("CHKDIR")} err_turns=${g("ERRS")} disk=${disk}`
    );
    say(`       last: ${g("LASTLOG")}`);

    // Comprehension: on the first pass, confirm the agent's session shows it
    // engaged with the actual problem (read the docs / stated a plan).
    if (ageMin < 25) {
      const compr = await exec(
        conn,
        'S=$(ls -t "$HOME/.pi/agent/sessions"/*.jsonl 2>/dev/null | head -1); ' +
          'if [ -n "$S" ]; then grep -oiE "problem\\.md|AGENTS\\.md|check_answer|verified_math|negative space|zig" "$S" | sort -u | tr \'\\n\' \' \'; fi'
      );
      say(`       comprehension cues: ${compr.trim() || "(none yet - turn may still be starting)"}`);
    }
  } finally {
    conn.end();
  }
}

async function pass(): Promise<void> {
  if (!existsSync(VMS_FILE)) return say("no /tmp/overnight-vms.json yet");
  const vms: Vm[] = JSON.parse(readFileSync(VMS_FILE, "utf8"));
  say(`\n===== monitor pass ${new Date().toISOString()} - ${vms.length} VMs =====`);
  for (const vm of vms) await probe(vm).catch((e) => say(`  probe error ${vm.problemName}: ${(e as Error).message}`));
}

const watchIdx = process.argv.indexOf("--watch");
if (watchIdx !== -1) {
  const mins = Number(process.argv[watchIdx + 1]) || 15;
  say(`[monitor] watching every ${mins} min (Ctrl-C to stop)`);
  await pass();
  setInterval(pass, mins * 60_000);
} else {
  await pass();
  process.exit(0);
}
