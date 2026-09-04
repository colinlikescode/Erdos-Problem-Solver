// Spin up real droplets for a set of problems and start each agent - the exact
// production path (spinupDroplet -> Session.open -> auto-start /start-new-agent).
// Records each VM to /tmp/overnight-vms.json for the monitor. The agents keep
// running in tmux after this process exits (that's the point).
//
//   bun tests/integration/overnight-launch.ts "Apéry Irrationality - warmup" "Arithmetic Kakeya - warmup" ...
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseDotEnv, resolveAgentEnv } from "../../src/electron/agentEnv";
import { spinupDroplet } from "../../src/electron/digitalocean";
import { Session } from "../../src/electron/session/children/session";
import type { ConnectionProfile, Problem } from "../../src/shared/types";

const REPO = join(process.cwd(), "..");
const dotenv = parseDotEnv(readFileSync(join(REPO, ".env"), "utf8"));
const agentEnv = resolveAgentEnv(dotenv, { openaiApiKey: "" });
const DO_TOKEN = dotenv.DIGITAL_OCEAN_API_KEY || "";
const VMS_FILE = "/tmp/overnight-vms.json";

const problems: Problem[] = JSON.parse(
  readFileSync(join(homedir(), "Library", "Application Support", "Star Fleet", "problems.json"), "utf8")
);

interface VmRecord {
  problemName: string;
  problemId: string;
  host: string;
  password: string;
  dropletId: number;
  startedAt: number;
}

const names = process.argv.slice(2);
if (!names.length) throw new Error("pass one or more problem names");

const existing: VmRecord[] = existsSync(VMS_FILE) ? JSON.parse(readFileSync(VMS_FILE, "utf8")) : [];

const slug = (s: string) =>
  "tabs-" + s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

for (const name of names) {
  const problem = problems.find((p) => p.name === name);
  if (!problem) {
    console.log(`SKIP: "${name}" not in the store`);
    continue;
  }
  console.log(`\n=== launching: ${name} ===`);
  try {
    const vm = await spinupDroplet(DO_TOKEN, { name: slug(name), seedProblem: problem.description }, (m) =>
      console.log(`  [spinup] ${m}`)
    );
    const profile: ConnectionProfile = {
      id: `overnight-${vm.dropletId}`,
      name: vm.name,
      host: vm.host,
      port: 22,
      username: vm.username,
      remotePath: "/root/snapshot",
      agent: "pi",
      authMethod: "password",
      problemId: problem.id,
      autoStart: true,
      dropletId: vm.dropletId,
      createdAt: Date.now(),
    };
    const session = new Session(profile, { password: vm.password }, agentEnv, problem.description);
    session.on("log", (_id, line) => console.log(`  [${name}] ${line}`));
    await session.open();
    session.disconnect(); // agent keeps running in tmux
    existing.push({
      problemName: name,
      problemId: problem.id,
      host: vm.host,
      password: vm.password,
      dropletId: vm.dropletId,
      startedAt: Date.now(),
    });
    writeFileSync(VMS_FILE, JSON.stringify(existing, null, 2));
    console.log(`  LAUNCHED ${name} on ${vm.host} (droplet ${vm.dropletId})`);
  } catch (e) {
    console.log(`  FAILED ${name}: ${(e as Error).message}`);
  }
}

console.log(`\n${existing.length} VMs recorded in ${VMS_FILE}`);
