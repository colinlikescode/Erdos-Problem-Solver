// Spin up one real DigitalOcean droplet for a given problem, using the app's
// own spinupDroplet(), and write its provision script + connection env.
// Parameterized so several can run in parallel.
//
//   E2E_NAME=tabs-galois E2E_PROBLEM_FILE=/tmp/p2.txt E2E_OUT=/tmp/vm2.env \
//   E2E_PROVISION=/tmp/prov2.sh bun tests/integration/e2e-spin.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spinupDroplet } from "../../src/electron/digitalocean";
import { buildProvisionScript } from "../../src/electron/provision/orchestrator";
import { parseDotEnv, resolveAgentEnv } from "../../src/electron/agentEnv";

const ROOT = process.cwd();
const dotenv = parseDotEnv(readFileSync(join(ROOT, "..", ".env"), "utf8"));
const token = dotenv.DIGITAL_OCEAN_API_KEY || "";

const NAME = process.env.E2E_NAME || `tabs-e2e-${Date.now().toString(36)}`;
const PROBLEM = readFileSync(process.env.E2E_PROBLEM_FILE!, "utf8");
const OUT = process.env.E2E_OUT || "/tmp/e2e-vm.env";
const PROVISION = process.env.E2E_PROVISION || "/tmp/e2e-provision.sh";

const log = (m: string) => console.log(`[${NAME} ${new Date().toISOString()}] ${m}`);

const vm = await spinupDroplet(token, { name: NAME, seedProblem: PROBLEM }, log);
log(`droplet READY: root@${vm.host}`);

const env = resolveAgentEnv(dotenv, { openaiApiKey: "" });
writeFileSync(PROVISION, buildProvisionScript("pi", env, "/root/snapshot", PROBLEM));
writeFileSync(OUT, `HOST=root@${vm.host}\nPASSWORD=${vm.password}\nNAME=${vm.name}\nIP=${vm.host}\n`);
log(`wrote ${OUT} + ${PROVISION}`);
