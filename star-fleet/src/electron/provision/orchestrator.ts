import { createHash } from "node:crypto";
import type { AgentKind } from "../../shared/types";
import {
  b64,
  agentEnvExports,
  agentStartCommand,
  agentTmux,
  readImageAsset,
  snapshotTarB64,
} from "./children/shell";
import {
  sectionBaseSetup,
  sectionTmuxConfig,
  sectionInstallTools,
  sectionPiSettings,
  sectionSnapshot,
  sectionGitCleanup,
  sectionStartAgent,
} from "./children/sections";
import { sectionPiAuth, PI_SETTINGS } from "./children/auth";
import { sectionScaffolding } from "./children/scaffolding";

export { agentTmux, agentStartCommand } from "./children/shell";

/**
 * Idempotent provisioning, rerun on every open. Installs tmux + Node + Pi + Pi's
 * OpenAI extensions, seeds the regular OpenAI key (Codex auth comes from the
 * codex-broker at runtime - never seeded on disk), installs the trigger
 * scaffolding (supervisor + 90%-context handoff->compact), merges Pi settings
 * (compaction), and starts the agent in tmux so work keeps running when the
 * laptop is closed. This function is the provision orchestrator: it only
 * composes the section builders in `./sections`, `./auth`, `./scaffolding`.
 */
export function buildProvisionScript(
  defaultAgent: AgentKind,
  env: Record<string, string>,
  folder: string,
  seedProblem = ""
): string {
  return buildProvision(defaultAgent, env, folder, seedProblem).script;
}

/**
 * Same as buildProvisionScript, but also returns the version stamp. The script
 * writes the stamp to ~/.tabs/provision-stamp on success, so a session reopen
 * against an already-provisioned VM (stamp match + live tmux) can skip the
 * whole slow setup. Stamp = hash of the script body, so any change (env, code,
 * seeded problem) invalidates it and forces a real reprovision.
 */
export function buildProvision(
  defaultAgent: AgentKind,
  env: Record<string, string>,
  folder: string,
  seedProblem = ""
): { script: string; stamp: string } {
  const defTmux = agentTmux(defaultAgent);
  const startCmd = agentStartCommand(defaultAgent);
  const cd = `cd ${folder.replace(/"/g, "")} 2>/dev/null; `;

  const regularKey = env.OPENAI_REGULAR_API_KEY || "";

  // Trigger scaffolding (supervisor + codex account switch + compute brokers),
  // installed outside the agent's working dir. Only skipped if assets missing.
  const scaffolding = {
    agentLoopB64: b64(readImageAsset("scaffolding", "agent-loop.sh")),
    tabsReplB64: b64(readImageAsset("scaffolding", "tabs-repl.sh")),
    rebootResumeB64: b64(readImageAsset("scaffolding", "reboot-resume.sh")),
    brokerOrchestratorB64: b64(readImageAsset("scaffolding", "brokers/orchestrator.py")),
    brokerCommonB64: b64(readImageAsset("scaffolding", "brokers/children/common.py")),
    gpuBrokerB64: b64(readImageAsset("scaffolding", "brokers/children/gpu.py")),
    cpuBrokerB64: b64(readImageAsset("scaffolding", "brokers/children/cpu.py")),
    // Agent-callable tools (implementations live in scaffolding; the agent runs
    // them as commands on PATH - see sectionScaffolding).
    setupB64: b64(readImageAsset("scaffolding", "tools/setup.sh")),
    waitB64: b64(readImageAsset("scaffolding", "tools/wait.sh")),
    requirementsB64: b64(readImageAsset("scaffolding", "tools/requirements.txt")),
    webSearchB64: b64(readImageAsset("scaffolding", "tools/web_search.py")),
    researchB64: b64(readImageAsset("scaffolding", "tools/research.py")),
    leanSearchB64: b64(readImageAsset("scaffolding", "tools/lean_search.py")),
    llmClientB64: b64(readImageAsset("scaffolding", "tools/llm_client.py")),
    textOperatorB64: b64(readImageAsset("scaffolding", "tools/text_operator.sh")),
    newExperimentB64: b64(readImageAsset("scaffolding", "tools/new-experiment.sh")),
    newFactB64: b64(readImageAsset("scaffolding", "tools/new-fact.sh")),
    cpuWorkerDockerfileB64: b64(readImageAsset("scaffolding", "tools/cpu-worker/Dockerfile")),
    cpuWorkerIndexB64: b64(readImageAsset("scaffolding", "tools/cpu-worker/index.ts")),
    cpuWorkerWranglerB64: b64(readImageAsset("scaffolding", "tools/cpu-worker/wrangler.jsonc")),
    tplRustCargoB64: b64(readImageAsset("scaffolding", "tools/experiment-template/rust/Cargo.toml")),
    tplRustMainB64: b64(readImageAsset("scaffolding", "tools/experiment-template/rust/src/main.rs")),
    tplCudaMakefileB64: b64(readImageAsset("scaffolding", "tools/experiment-template/cuda/Makefile")),
    tplCudaSrcB64: b64(readImageAsset("scaffolding", "tools/experiment-template/cuda/src/search.cu")),
    tplLeanLakefileB64: b64(readImageAsset("scaffolding", "tools/experiment-template/lean/lakefile.toml")),
    tplLeanToolchainB64: b64(readImageAsset("scaffolding", "tools/experiment-template/lean/lean-toolchain")),
    tplLeanBasicB64: b64(readImageAsset("scaffolding", "tools/experiment-template/lean/Research/Basic.lean")),
  };
  const scaffoldingEnabled = Object.values(scaffolding).every(Boolean);

  // The research snapshot, placed on the VM at ~/snapshot (once, never clobbered).
  const snapshotTgz = snapshotTarB64();

  const body = [
    sectionBaseSetup(agentEnvExports(env)),
    sectionTmuxConfig(),
    sectionInstallTools(),
    sectionPiSettings(b64(PI_SETTINGS)),
    sectionPiAuth(regularKey),
    scaffoldingEnabled ? sectionScaffolding(scaffolding) : "",
    // The base snapshot tarball, placed at ~/snapshot once. Continue-runs get
    // their saved cargo overlaid AFTERWARDS by the app (session restore hook,
    // streamed from R2) - provisioning is identical for both run kinds.
    snapshotTgz ? sectionSnapshot(snapshotTgz, seedProblem ? b64(seedProblem) : "") : "",
    // Retired GitHub-sync machinery is scrubbed from older VMs (R2 owns saves).
    sectionGitCleanup(),
    sectionStartAgent(defTmux, startCmd, cd),
  ].join("\n");

  const stamp = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const script = `${body}
# Provision succeeded end to end - record the version so reopens can skip it.
printf %s "${stamp}" > "$HOME/.tabs/provision-stamp"`;
  return { script, stamp };
}
