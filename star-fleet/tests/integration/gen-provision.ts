// Generate the provision script exactly as the app would, from the real .env,
// and write it to the path given as argv[2] (default /tmp/tabs-provision.sh).
// Used by live.sh for the on-droplet integration tests.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProvisionScript } from "../../src/electron/provision/orchestrator";
import { parseDotEnv, resolveAgentEnv } from "../../src/electron/agentEnv";

// cwd = star-fleet/; the shared `.env` lives at the repo root above it.
const ROOT = process.cwd();
const out = process.argv[2] || "/tmp/tabs-provision.sh";
// Same default as real profiles: the provisioner-placed snapshot folder.
const folder = process.argv[3] || "/home/ubuntu/snapshot";

let dotenv: Record<string, string> = {};
try {
  dotenv = parseDotEnv(readFileSync(join(ROOT, "..", ".env"), "utf8"));
} catch {
  /* none */
}
const env = resolveAgentEnv(dotenv, { openaiApiKey: "" });
const script = buildProvisionScript("pi", env, folder);
writeFileSync(out, script);
console.log(`wrote ${out} (${script.length} bytes)`);
