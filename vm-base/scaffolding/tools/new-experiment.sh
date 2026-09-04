#!/usr/bin/env bash
#
# Fork a new experiment - the disciplined "copy the previous attempt and iterate"
# helper. Installed on PATH by the provisioner; the agent runs it from the
# snapshot root. Not git (the agent never touches git) - just a thin directory
# copy that skips build output and re-links the shared/ heavy-inputs folder.
#
#   new-experiment <slug> [--from <dir>]
#
# Picks the next experiment_<n>, copies SOURCE only from the most recent
# experiment (or --from <dir>) excluding build dirs, re-links workspace/shared,
# writes a fresh scratchpad.md, and prints the new path. First run makes a clean
# skeleton. You could do this by hand with `cp -r`/`rsync`; this just keeps the
# fork thin and consistent every time.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"          # scaffolding/tools (holds the template)
TEMPLATE="$HERE/experiment-template"           # generic rust/cuda/lean skeleton
ROOT="$(pwd)"
[ -f "$ROOT/problem.md" ] || { echo "[new-experiment] run me from the snapshot root (no problem.md here)"; exit 1; }

EXP_DIR="$ROOT/workspace/experiments"
SHARED="$ROOT/workspace/shared"
mkdir -p "$EXP_DIR" "$SHARED"

# Build dirs / caches never carried into a fork (keep experiments thin). Also
# scratchpad.md: each experiment gets a fresh one - a fork is a new attempt, not
# a continuation of the parent's notes.
EXCLUDES=(target .lake lake-packages .venv build dist node_modules __pycache__ .cache shared scratchpad.md)

slug=""; from=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from="${2:-}"; shift 2 ;;
    --from=*) from="${1#*=}"; shift ;;
    -*) echo "[new-experiment] unknown option: $1"; exit 1 ;;
    *) slug="$1"; shift ;;
  esac
done
# Sanitize the slug to a safe folder token.
slug="$(printf '%s' "$slug" | tr ' ' '_' | tr -cd 'a-zA-Z0-9_-')"

# Next index = (highest existing experiment_<n>) + 1.
n=0
for d in "$EXP_DIR"/experiment_*/; do
  [ -d "$d" ] || continue
  base="$(basename "$d")"; num="${base#experiment_}"; num="${num%%_*}"
  case "$num" in ''|*[!0-9]*) : ;; *) [ "$num" -gt "$n" ] && n="$num" ;; esac
done
next=$(( n + 1 ))
name="experiment_${next}${slug:+_$slug}"
dest="$EXP_DIR/$name"
[ -e "$dest" ] && { echo "[new-experiment] $dest already exists"; exit 1; }

# Source to fork from, in order: --from, else the most recent experiment, else
# the generic template (rust/cuda/lean skeleton shipped in scaffolding).
src="$from"
if [ -z "$src" ] && [ "$n" -gt 0 ]; then
  for d in "$EXP_DIR"/experiment_"$n"_*/ "$EXP_DIR"/experiment_"$n"/; do
    [ -d "$d" ] && { src="${d%/}"; break; }
  done
fi
kind="previous experiment"
if [ -z "$src" ] && [ -d "$TEMPLATE" ]; then src="$TEMPLATE"; kind="template"; fi

mkdir -p "$dest"
if [ -n "$src" ] && [ -d "$src" ]; then
  echo "[new-experiment] seeding from $kind: $(basename "$src") (build output excluded)"
  if command -v rsync >/dev/null 2>&1; then
    args=(); for e in "${EXCLUDES[@]}"; do args+=(--exclude "$e"); done
    rsync -a "${args[@]}" "$src"/ "$dest"/
  else
    # Portable fallback: copy everything, then prune the excluded dirs.
    cp -a "$src"/. "$dest"/ 2>/dev/null || true
    for e in "${EXCLUDES[@]}"; do rm -rf "${dest:?}/$e"; done
  fi
else
  echo "[new-experiment] starting from an empty folder (no template found)"
fi

# Re-link the shared heavy-inputs folder (relative, so it survives moves/forks).
rm -f "$dest/shared" 2>/dev/null || true
ln -s ../../shared "$dest/shared"

# Each experiment keeps its own scratchpad.md (this attempt's local notes). The
# whole-project journal is the snapshot-root notebook.md - keep both current.
cat > "$dest/scratchpad.md" <<NOTES
# $name - scratchpad (this attempt's notes)

- **Hypothesis:**
- **Approach:**
- **Outcome so far:** in progress | partial | DEAD END
- **Forked from:** ${src:+$(basename "$src")}${src:-clean skeleton}

_(Local notes for this experiment. Roll the big picture / cross-experiment
dead ends up into ../../notebook.md.)_
NOTES

echo "[new-experiment] created workspace/experiments/$name  (shared -> ../../shared)"
echo "workspace/experiments/$name"
