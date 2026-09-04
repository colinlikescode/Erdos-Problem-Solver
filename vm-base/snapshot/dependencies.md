# dependencies.md - what's already on this box

An inventory of the building blocks available locally. These are just tools;
reach for whatever fits the problem. Nothing here prescribes an approach. If
something is missing, you have full internet and root: install it
(`apt-get install -y ...`, `.venv/bin/pip install ...`, `cargo add ...`,
`elan`/`rustup`). Don't work around a gap or ask. Install and move on.

`setup.sh` installs everything below (idempotent; run it once on a fresh box).

## Toolchains

- Rust (`cargo`, `rustc`) via rustup.
- Lean 4 (`lake`, `lean`) + Mathlib. elan manages the toolchain; Mathlib is
  fetched per experiment (`lake exe cache get`).
- Python 3 with a project venv at `./.venv` (packages below).
- C/C++ build stack and headers: `build-essential`, `libgmp-dev`,
  `libmpfr-dev`, `libflint-dev`, `libntl-dev`, so performance-critical C/Rust
  crates compile against fast arithmetic libs.

## Computer algebra systems (on PATH)

- `sage` (SageMath). Bundles most of the below plus flint/arb, NTL,
  eclib/`mwrank`, fplll (LLL), nauty, cddlib/lrslib, and its number theory and
  combinatorics databases and constructors.
- `gp` (Pari/GP), `gap`, `Singular`, `M2` (Macaulay2, best effort), `maxima`,
  `octave` (MATLAB-compatible).
- Magma is not installed (proprietary). Sage covers most of the same ground;
  emit output in the requested Magma/M2 format when asked.

## Solvers

- SMT: `z3` (CLI and `z3-solver` in the venv).
- SAT: `kissat`, `cadical`, `cryptominisat5` (CLI).
- Constraint modeling: `minizinc`.
- LP/MILP/convex/SDP: `pulp`, `ortools`, `cvxpy` (with SCS/OSQP), `scipy` HiGHS.

## Python venv (`./.venv`) baseline

`numpy`, `scipy`, `sympy`, `galois`, `networkx`, `pulp`, `ortools`,
`z3-solver`, `cvxpy`, `pandas`, `matplotlib`, plus `mpmath` (arbitrary
precision, via sympy). Add more with `.venv/bin/pip install`.

## Online resources (via the search skills)

Reachable through `web-search` / `research-search`, not local installs. OEIS,
LMFDB, arXiv and the other subject databases are a search away when a problem
calls for them.
