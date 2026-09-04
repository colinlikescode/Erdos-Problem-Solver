// Stateless builders for the discrete phases of the provision script. Each
// returns a shell fragment; the provision orchestrator composes them in order.
import { shellSingleQuote } from "./shell";
import { SCAFFOLDING_DIR } from "./scaffolding";

/** Run lock, sudo/apt detection, PATH, and the agent env file. */
export function sectionBaseSetup(envExports: string): string {
  return `
set -e
exec 9>"$HOME/.tabs-provision.lock"
if ! flock -n 9; then
  echo "[tabs] another setup run is in progress, waiting..."
  flock 9
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo -n"; fi
APT="$SUDO env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600"
# Put user-local + npm-global bins on PATH so "command -v pi" resolves.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
$SUDO env DEBIAN_FRONTEND=noninteractive dpkg --configure -a 2>/dev/null || true

# Per-VM instance id (6 hex chars), minted once. Used to tag outbound
# notifications (text-operator skill) so the operator knows which machine is talking.
mkdir -p "$HOME/.tabs"
if [ ! -s "$HOME/.tabs/instance-id" ]; then
  head -c3 /dev/urandom | od -An -tx1 | tr -d ' \\n' > "$HOME/.tabs/instance-id"
fi

# API keys + PATH for the agent, sourced whenever it starts.
umask 077
cat > "$HOME/.tabs-agent.env" <<'ENVEOF'
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
${envExports}
ENVEOF`;
}

/** tmux config for the embedded terminal (no status bar, mouse, big scrollback). */
export function sectionTmuxConfig(): string {
  return `
cat > "$HOME/.tmux.conf" <<'TMUXEOF'
set -g status off
set -g mouse on
set -g history-limit 100000
set -g focus-events on
set -g default-terminal "xterm-256color"
TMUXEOF
tmux set -g status off 2>/dev/null || true`;
}

/** Install tmux/curl/git, Node.js, Pi, and Pi's OpenAI extensions. */
export function sectionInstallTools(): string {
  return `
echo "[tabs] checking base tools..."
if ! command -v tmux >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  echo "[tabs] installing tmux + curl + git..."
  $APT update -y
  $APT install -y --no-install-recommends tmux curl ca-certificates git
fi

# Install Node.js when EITHER node OR npm is missing. Ubuntu cloud images
# (e.g. DigitalOcean) often ship a partial 'node' with NO npm, so guarding on
# node alone silently leaves npm absent and Pi never installs. NodeSource's
# package bundles npm; if apt is uncooperative, fall back to distro nodejs+npm.
# Install Node 22 (Pi needs >=22.19) + npm when EITHER is missing OR node is
# too old. Ubuntu cloud images (DigitalOcean) ship node 18 with NO npm, and
# Pi's ESM uses regex flags node 18 cannot parse -- so an 18-only box silently
# yields a broken pi. NOTE: pipe to SUDO bash -, NOT SUDO -E bash -: as root
# SUDO is empty, so "-E bash -" runs the bogus command "-E" and the NodeSource
# repo never gets configured (the bug that pinned us at node 18).
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//; s/\\..*//')"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || [ "\${NODE_MAJOR:-0}" -lt 22 ]; then
  echo "[tabs] installing Node.js 22 + npm..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash - || true
  $APT install -y nodejs || true
  command -v npm >/dev/null 2>&1 || $APT install -y npm || true
  echo "[tabs] node $(node -v 2>/dev/null), npm $(npm -v 2>/dev/null)"
fi

# npm global installs into a user-owned prefix so we never need sudo for pi.
npm config set prefix "$HOME/.npm-global" >/dev/null 2>&1 || true
export PATH="$HOME/.npm-global/bin:$PATH"

echo "[tabs] checking Pi (agent harness)..."
if ! command -v pi >/dev/null 2>&1; then
  echo "[tabs] installing Pi..."
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent || echo "[tabs] warning: pi install failed"
fi

# Pi extension: Codex ChatGPT-account provider (openai-codex), the credential
# the supervisor writes broker-vended tokens into.
# Marker-guarded: installed once per VM, silent no-op on every later provision.
for pkg in pi-codex-account; do
  if [ ! -f "$HOME/.tabs/ext-$pkg.ok" ]; then
    echo "[tabs] installing pi extension: $pkg"
    if pi install "npm:$pkg" >/dev/null 2>&1; then
      touch "$HOME/.tabs/ext-$pkg.ok"
    else
      echo "[tabs] warning: pi extension $pkg failed"
    fi
  fi
done`;
}

/**
 * Merge Pi's global settings (compaction + project trust) into settings.json.
 * Must merge, not overwrite - `pi install` records installed extensions in a
 * `packages` array there, and clobbering the file would silently uninstall them.
 */
export function sectionPiSettings(piSettingsB64: string): string {
  return `
mkdir -p "$HOME/.pi/agent"
PI_SETTINGS_B64='${piSettingsB64}' node -e '
  const fs = require("fs"), os = require("os"), path = require("path");
  const p = path.join(os.homedir(), ".pi", "agent", "settings.json");
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  const add = JSON.parse(Buffer.from(process.env.PI_SETTINGS_B64, "base64").toString("utf8"));
  fs.writeFileSync(p, JSON.stringify({ ...cur, ...add }, null, 2), { mode: 0o600 });
' && echo "[tabs] Pi settings merged (compaction + trust)" || echo "[tabs] warning: pi settings merge failed"`;
}

/**
 * Place the research snapshot on the VM in its own dedicated folder
 * (~/snapshot) - once. Never overwrites: an existing ~/snapshot means work in
 * progress (or a fork that inherited one) and must not be clobbered. When a
 * seed problem is provided (from the "New VM" form), it's written into
 * problem.md as part of that first placement so the box comes up preconfigured.
 */
export function sectionSnapshot(snapshotTgzB64: string, seedProblemB64 = ""): string {
  const seedProblem = seedProblemB64
    ? `\n  echo '${seedProblemB64}' | base64 -d > "$HOME/snapshot/problem.md"\n  echo "[tabs] seeded problem.md from the New VM form"`
    : "";
  return `
if [ ! -d "$HOME/snapshot" ]; then
  echo "[tabs] placing research snapshot at ~/snapshot..."
  echo '${snapshotTgzB64}' | base64 -d | tar -xzf - -C "$HOME"${seedProblem}
  # Empty working folders - git does not track empty directories, so a fresh
  # clone's snapshot tarball lacks them; create them here so the layout the
  # agent's AGENTS.md describes is always present.
  mkdir -p "$HOME/snapshot/check_answer" "$HOME/snapshot/workspace/shared" "$HOME/snapshot/workspace/experiments"
  echo "[tabs] snapshot placed (edit ~/snapshot/problem.md, then /start-new-agent)"
else
  echo "[tabs] snapshot already present at ~/snapshot, leaving it untouched"
fi`;
}

/**
 * Clean up the retired GitHub-sync machinery on already-provisioned VMs
 * (replaced by R2 run saves): the sync script, the PAT env file,
 * and the external gitdir. Runs on every provision; silent no-op when clean.
 */
export function sectionGitCleanup(): string {
  return `
rm -f "${SCAFFOLDING_DIR}/github-sync.sh" "$HOME/.tabs/github.env" "$HOME/.tabs/github-repo"
rm -rf "$HOME/.tabs/snapshot-git"`;
}

/**
 * Start the agent in its own tmux session so it survives laptop close.
 *
 * critical: the provision run holds the setup lock on fd 9 (`exec 9>lock` in
 * sectionBaseSetup). The tmux SERVER is a long-lived daemon; if it inherits
 * fd 9 it holds the lock for the entire life of the agent session, and the
 * NEXT provision (reconnect / reopen) blocks forever on `flock`. So every tmux
 * spawn here closes fd 9 (`9>&-`) - the daemon must not inherit the lock.
 */
export function sectionStartAgent(defTmux: string, runCmd: string, cd: string): string {
  return `
if tmux has-session -t ${defTmux} 2>/dev/null; then
  echo "[tabs] agent session already running"
else
  echo "[tabs] starting default agent in tmux '${defTmux}'..."
  tmux new-session -d -s ${defTmux} "${cd}source \\$HOME/.tabs-agent.env 2>/dev/null; ${runCmd}; exec \\$SHELL" 2>/dev/null 9>&- || \\
    tmux new-session -d -s ${defTmux} 9>&-
fi

echo "[tabs] ready"`;
}
