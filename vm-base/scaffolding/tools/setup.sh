#!/usr/bin/env bash
#
# Prepare this snapshot's environment ("build the image"). Run once after forking
# the snapshot onto a VM; safe to re-run (idempotent). Sets up the baseline
# dependencies the agent expects - most importantly Lean + Mathlib.
#
# Installed on PATH by the provisioner (implementation lives in scaffolding, not
# the snapshot). Run it from the snapshot root:
#   setup.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"   # scaffolding/tools (holds requirements.txt)
ROOT="$(pwd)"                           # the agent's snapshot (current directory)

echo "[setup] preparing snapshot environment in $ROOT"

# --- Lean 4 toolchain (elan) -------------------------------------------------
# Install the Lean toolchain manager so `lake`/`lean` exist. The per-experiment
# Lean project (seeded from the template by `new-experiment`) pulls Mathlib on
# its first build via `lake exe cache get` (downloads prebuilt oleans - fast,
# not a from-scratch compile). Nothing to prebuild here; experiments own their
# Lean code, big shared artifacts (if any) go in workspace/shared/.
if ! command -v elan >/dev/null 2>&1 && [ ! -x "$HOME/.elan/bin/elan" ]; then
  echo "[setup] installing elan (Lean toolchain manager)..."
  curl -fsSL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --default-toolchain none
fi
export PATH="$HOME/.elan/bin:$PATH"

# --- Rust --------------------------------------------------------------------
if ! command -v cargo >/dev/null 2>&1; then
  echo "[setup] installing Rust (rustup)..."
  curl -fsSL https://sh.rustup.rs | sh -s -- -y
fi
export PATH="$HOME/.cargo/bin:$PATH"

# --- Python math tools -------------------------------------------------------
# venv in the snapshot root (.venv); package list ships beside this script.
if command -v python3 >/dev/null 2>&1; then
  echo "[setup] setting up Python math tools venv (.venv)..."
  python3 -m venv "$ROOT/.venv" 2>/dev/null || true
  "$ROOT/.venv/bin/pip" install -q --upgrade pip 2>/dev/null || true
  "$ROOT/.venv/bin/pip" install -q -r "$HERE/requirements.txt" 2>/dev/null \
    || echo "[setup] warn: python tools install incomplete"
fi

# --- Building blocks: CAS, solvers, build headers ----------------------------
# Broad, general-purpose math tooling predownloaded so it's on hand - not a
# prescription of any approach (see dependencies.md). All best-effort: a missing
# package must never fail setup. SageMath bundles Pari/GP, GAP, Singular, Maxima,
# flint/arb, NTL, eclib/mwrank, fplll, nauty, and number-theory databases.
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo -n"
APT="$SUDO env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600"
$APT update -y 2>/dev/null || true
# C/C++ build stack + fast-arithmetic headers (so C/Rust crates compile).
$APT install -y --no-install-recommends \
  build-essential libgmp-dev libmpfr-dev libflint-dev libntl-dev \
  2>/dev/null || echo "[setup] warn: some build headers did not install (continuing)"
# Computer-algebra systems + MATLAB-compatible Octave.
if ! command -v sage >/dev/null 2>&1; then
  echo "[setup] installing computer-algebra systems (sage, pari, gap, singular, maxima, octave)..."
  $APT install -y --no-install-recommends \
    sagemath pari-gp gap singular maxima octave \
    sagemath-database-conway-polynomials sagemath-database-cremona-elliptic-curves \
    2>/dev/null || echo "[setup] warn: some CAS packages did not install (continuing)"
fi
# Solvers: SAT (kissat/cadical/cryptominisat), constraint modeling (minizinc).
# (z3 + LP/SDP live in the Python venv via requirements.txt.)
$APT install -y --no-install-recommends \
  kissat cadical cryptominisat minizinc \
  2>/dev/null || echo "[setup] warn: some solvers did not install (continuing)"
# Macaulay2 (algebraic geometry / commutative algebra) - not in default apt;
# best-effort via its maintained Ubuntu repo. Skip quietly if it doesn't resolve.
if ! command -v M2 >/dev/null 2>&1; then
  ( $SUDO add-apt-repository -y ppa:macaulay2/macaulay2 2>/dev/null \
    && $APT update -y 2>/dev/null \
    && $APT install -y macaulay2 2>/dev/null ) \
    || echo "[setup] note: Macaulay2 not installed (add its repo manually if needed)."
fi

echo "[setup] done. Toolchains + CAS + solvers installed - full inventory in dependencies.md."
echo "[setup] Need more compute? gpu-burst / cpu-burst (see AGENTS.md §2a)."
