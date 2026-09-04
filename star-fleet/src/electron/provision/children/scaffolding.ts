// Installs the trigger scaffolding (vm-base/scaffolding/) on the VM:
// the never-stop supervisor with the 90%-context handoff->compact trigger,
// tabs-repl, and the compute brokers behind the gpu-burst / cpu-burst skills.
// Lives at ~/.tabs/scaffolding - OUTSIDE the agent's working directory, so Pi
// is blind to the machinery/policy; only the gpu-burst/cpu-burst wrapper
// commands are exposed on PATH.

export const SCAFFOLDING_DIR = "$HOME/.tabs/scaffolding";
export const TOOLS_DIR = `${SCAFFOLDING_DIR}/tools`;

/** Atomic write helper: temp file + mv so running readers are never corrupted. */
function atomicWrite(b64: string, dest: string, exec: boolean): string {
  const tmp = `${dest}.new`;
  return [
    `echo '${b64}' | base64 -d > "${tmp}"`,
    ...(exec ? [`chmod +x "${tmp}"`] : []),
    `mv -f "${tmp}" "${dest}"`,
  ].join("\n");
}

export interface ScaffoldingAssets {
  agentLoopB64: string;
  tabsReplB64: string;
  rebootResumeB64: string;
  brokerOrchestratorB64: string;
  brokerCommonB64: string;
  gpuBrokerB64: string;
  cpuBrokerB64: string;
  setupB64: string;
  waitB64: string;
  requirementsB64: string;
  webSearchB64: string;
  researchB64: string;
  leanSearchB64: string;
  llmClientB64: string;
  textOperatorB64: string;
  newExperimentB64: string;
  newFactB64: string;
  cpuWorkerDockerfileB64: string;
  cpuWorkerIndexB64: string;
  cpuWorkerWranglerB64: string;
  // Generic experiment template (new-experiment seeds each attempt from it).
  tplRustCargoB64: string;
  tplRustMainB64: string;
  tplCudaMakefileB64: string;
  tplCudaSrcB64: string;
  tplLeanLakefileB64: string;
  tplLeanToolchainB64: string;
  tplLeanBasicB64: string;
}

/** A tool command exposed on the agent's PATH. `cmd` is the name the agent
 *  runs; `target` is the installed implementation under scaffolding/tools. */
function pathWrapper(cmd: string, target: string): string {
  return [
    `cat > "$HOME/.local/bin/${cmd}" <<'WRAPEOF'`,
    `#!/usr/bin/env bash`,
    `exec "${target}" "$@"`,
    `WRAPEOF`,
    `chmod +x "$HOME/.local/bin/${cmd}"`,
  ].join("\n");
}

/**
 * Write all scaffolding files on every provision so VMs always run the latest
 * versions (atomic writes; a running supervisor keeps its old inode). Exposes
 * `gpu-burst` and `cpu-burst` wrappers on PATH - the skills teach those; the
 * broker policy stays hidden here.
 */
export function sectionScaffolding(a: ScaffoldingAssets): string {
  return `
echo "[tabs] installing agent scaffolding (supervisor + compute brokers)..."
mkdir -p "${SCAFFOLDING_DIR}/brokers/children" "$HOME/.local/bin"
${atomicWrite(a.agentLoopB64, `${SCAFFOLDING_DIR}/agent-loop.sh`, true)}
${atomicWrite(a.tabsReplB64, `${SCAFFOLDING_DIR}/tabs-repl.sh`, true)}
${atomicWrite(a.rebootResumeB64, `${SCAFFOLDING_DIR}/reboot-resume.sh`, true)}
# Reboot resilience for long (multi-week) runs: a @reboot cron restarts the
# never-stop loop if the box reboots WHILE a run was active (guarded by the
# ~/.tabs/agent-should-run intent marker). Idempotent - installed once.
if command -v crontab >/dev/null 2>&1; then
  ( crontab -l 2>/dev/null | grep -v 'tabs/scaffolding/reboot-resume.sh'; \
    echo "@reboot $SCAFFOLDING_DIR/reboot-resume.sh" ) | crontab - 2>/dev/null \
    && echo "[tabs] reboot-resume cron installed" || echo "[tabs] warning: could not install reboot-resume cron"
fi
${atomicWrite(a.brokerOrchestratorB64, `${SCAFFOLDING_DIR}/brokers/orchestrator.py`, true)}
${atomicWrite(a.brokerCommonB64, `${SCAFFOLDING_DIR}/brokers/children/common.py`, false)}
${atomicWrite(a.gpuBrokerB64, `${SCAFFOLDING_DIR}/brokers/children/gpu.py`, false)}
${atomicWrite(a.cpuBrokerB64, `${SCAFFOLDING_DIR}/brokers/children/cpu.py`, false)}
cat > "$HOME/.local/bin/gpu-burst" <<'GPUBURSTEOF'
#!/usr/bin/env bash
exec python3 "$HOME/.tabs/scaffolding/brokers/orchestrator.py" gpu "$@"
GPUBURSTEOF
chmod +x "$HOME/.local/bin/gpu-burst"
cat > "$HOME/.local/bin/cpu-burst" <<'CPUBURSTEOF'
#!/usr/bin/env bash
exec python3 "$HOME/.tabs/scaffolding/brokers/orchestrator.py" cpu "$@"
CPUBURSTEOF
chmod +x "$HOME/.local/bin/cpu-burst"

# Agent-callable tools: implementations under scaffolding/tools, each exposed as
# a command on PATH so the agent never reaches into the machinery directly.
mkdir -p "${TOOLS_DIR}/cpu-worker"
${atomicWrite(a.setupB64, `${TOOLS_DIR}/setup.sh`, true)}
${atomicWrite(a.waitB64, `${TOOLS_DIR}/wait.sh`, true)}
${atomicWrite(a.requirementsB64, `${TOOLS_DIR}/requirements.txt`, false)}
${atomicWrite(a.webSearchB64, `${TOOLS_DIR}/web_search.py`, true)}
${atomicWrite(a.researchB64, `${TOOLS_DIR}/research.py`, true)}
${atomicWrite(a.leanSearchB64, `${TOOLS_DIR}/lean_search.py`, true)}
${atomicWrite(a.llmClientB64, `${TOOLS_DIR}/llm_client.py`, false)}
${atomicWrite(a.textOperatorB64, `${TOOLS_DIR}/text_operator.sh`, true)}
${atomicWrite(a.newExperimentB64, `${TOOLS_DIR}/new-experiment.sh`, true)}
${atomicWrite(a.newFactB64, `${TOOLS_DIR}/new-fact.sh`, true)}
rm -f "${TOOLS_DIR}/submit-done.sh" "$HOME/.local/bin/submit-done.sh"  # retired (text-operator is the only handoff)
${atomicWrite(a.cpuWorkerDockerfileB64, `${TOOLS_DIR}/cpu-worker/Dockerfile`, false)}
${atomicWrite(a.cpuWorkerIndexB64, `${TOOLS_DIR}/cpu-worker/index.ts`, false)}
${atomicWrite(a.cpuWorkerWranglerB64, `${TOOLS_DIR}/cpu-worker/wrangler.jsonc`, false)}
# Generic experiment template (rust/cuda/lean skeleton) new-experiment seeds from.
mkdir -p "${TOOLS_DIR}/experiment-template/rust/src" "${TOOLS_DIR}/experiment-template/cuda/src" "${TOOLS_DIR}/experiment-template/lean/Research"
${atomicWrite(a.tplRustCargoB64, `${TOOLS_DIR}/experiment-template/rust/Cargo.toml`, false)}
${atomicWrite(a.tplRustMainB64, `${TOOLS_DIR}/experiment-template/rust/src/main.rs`, false)}
${atomicWrite(a.tplCudaMakefileB64, `${TOOLS_DIR}/experiment-template/cuda/Makefile`, false)}
${atomicWrite(a.tplCudaSrcB64, `${TOOLS_DIR}/experiment-template/cuda/src/search.cu`, false)}
${atomicWrite(a.tplLeanLakefileB64, `${TOOLS_DIR}/experiment-template/lean/lakefile.toml`, false)}
${atomicWrite(a.tplLeanToolchainB64, `${TOOLS_DIR}/experiment-template/lean/lean-toolchain`, false)}
${atomicWrite(a.tplLeanBasicB64, `${TOOLS_DIR}/experiment-template/lean/Research/Basic.lean`, false)}
${pathWrapper("setup.sh", `${TOOLS_DIR}/setup.sh`)}
${pathWrapper("wait.sh", `${TOOLS_DIR}/wait.sh`)}
${pathWrapper("web-search", `${TOOLS_DIR}/web_search.py`)}
${pathWrapper("research-search", `${TOOLS_DIR}/research.py`)}
${pathWrapper("lean-search", `${TOOLS_DIR}/lean_search.py`)}
${pathWrapper("text-operator", `${TOOLS_DIR}/text_operator.sh`)}
${pathWrapper("new-experiment", `${TOOLS_DIR}/new-experiment.sh`)}
${pathWrapper("new-fact", `${TOOLS_DIR}/new-fact.sh`)}
echo "[tabs] scaffolding ready (supervisor + brokers + agent tools on PATH)"`;
}
