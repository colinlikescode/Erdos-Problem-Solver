// One-shot end-to-end driver: spin up a real DigitalOcean droplet using the
// app's own spinupDroplet(), provision it exactly as the app would, seed
// problem.md, and print the connection details. Nothing here is a mock - this
// is the same code the "New DigitalOcean VM" button runs.
//
//   bun tests/integration/e2e-run.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spinupDroplet } from "../../src/electron/digitalocean";
import { buildProvisionScript } from "../../src/electron/provision/orchestrator";
import { parseDotEnv, resolveAgentEnv } from "../../src/electron/agentEnv";

const ROOT = process.cwd();
const dotenv = parseDotEnv(readFileSync(join(ROOT, "..", ".env"), "utf8"));
const token = dotenv.DIGITAL_OCEAN_API_KEY || "";

const PROBLEM =
  "Produce an algorithm that can factor balanced 150-digit semiprimes on a " +
  "typical modern laptop in under ten minutes.\n\n" +
  "Solved means: a working, reproducible implementation plus evidence it " +
  "factors randomly-generated balanced 150-digit semiprimes (two ~75-digit " +
  "primes) in under 10 minutes of wall-clock time on commodity laptop " +
  "hardware, with the method and its correctness clearly documented.\n";

const log = (m: string) => console.log(`[e2e ${new Date().toISOString()}] ${m}`);

const vm = await spinupDroplet(token, { name: `tabs-e2e-${Date.now().toString(36)}`, seedProblem: PROBLEM }, log);
log(`droplet READY: root@${vm.host} (password auth)`);

// DO droplets log in as root, so the snapshot lives at /root/snapshot.
const env = resolveAgentEnv(dotenv, { openaiApiKey: "" });
const script = buildProvisionScript("pi", env, "/root/snapshot", PROBLEM);
writeFileSync("/tmp/e2e-provision.sh", script);
log(`provision script written (${script.length} bytes)`);

// Emit the details the outer shell needs to drive the rest over SSH.
writeFileSync(
  "/tmp/e2e-vm.env",
  `HOST=root@${vm.host}\nPASSWORD=${vm.password}\nNAME=${vm.name}\nIP=${vm.host}\n`
);
log("wrote /tmp/e2e-vm.env");
