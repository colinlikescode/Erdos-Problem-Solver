#!/usr/bin/env bash
#
# Mint a new verified_math fact - the disciplined way to grow the truth store.
# Installed on PATH by the provisioner; run from the snapshot root after a
# result is machine-verified (Lean lake build / named gate / answer checker).
#
#   new-fact <short-slug> [--tier lean|gate|census] [--negative]
#            [--depends F-001,F-002] [--supersedes F-011]
#
# It picks the next zero-padded id (matching the repo's existing prefix - F- by
# default, V- if that's what the folders use), creates
# verified_math/<id>_<slug>/entry.md with the frontmatter template, and appends
# the one-liner to verified_math/verified_math.md. You then fill in the entry
# body (statement + proof sketch + one-sentence ledger line) and copy the proof
# artifacts into the folder. Hygiene by tooling: ids stay sequential and sorted,
# frontmatter stays parseable, the ledger stays one-line-per-fact.
set -u

ROOT="$(pwd)"
VM="$ROOT/verified_math"
LEDGER="$VM/verified_math.md"
[ -f "$ROOT/problem.md" ] || { echo "[new-fact] run me from the snapshot root (no problem.md here)"; exit 1; }
[ -d "$VM" ] || { echo "[new-fact] no verified_math/ folder here"; exit 1; }
[ -f "$LEDGER" ] || { echo "[new-fact] no verified_math/verified_math.md ledger here"; exit 1; }

SLUG="${1:-}"
[ -n "$SLUG" ] || { echo "usage: new-fact <short-slug> [--tier lean|gate|census] [--negative] [--depends F-001,F-002] [--supersedes F-011]"; exit 1; }
shift

TIER="lean"
POLARITY="positive"
DEPENDS=""
SUPERSEDES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tier)       TIER="${2:-lean}"; shift 2 ;;
    --negative)   POLARITY="negative"; shift ;;
    --depends)    DEPENDS="${2:-}"; shift 2 ;;
    --supersedes) SUPERSEDES="${2:-}"; shift 2 ;;
    *) echo "[new-fact] unknown option: $1"; exit 1 ;;
  esac
done
case "$TIER" in lean|gate|census) ;; *) echo "[new-fact] --tier must be lean, gate, or census"; exit 1 ;; esac

# Sanitize the slug: lowercase kebab, trimmed, capped (full words preserved up
# to the cap - no mid-word truncation surprises at sane lengths).
SLUG="$(printf %s "$SLUG" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//' | cut -c1-60 | sed 's/-$//')"
[ -n "$SLUG" ] || { echo "[new-fact] slug is empty after sanitizing"; exit 1; }

# Detect the id prefix + zero-pad width from existing fact folders; default to
# F- with 3 digits for a fresh snapshot.
PREFIX="F"
WIDTH=3
LAST=0
for d in "$VM"/*/; do
  base="$(basename "$d")"
  if [[ "$base" =~ ^([A-Z])-([0-9]+)[a-z]?_ ]]; then
    PREFIX="${BASH_REMATCH[1]}"
    n=$((10#${BASH_REMATCH[2]}))
    w=${#BASH_REMATCH[2]}
    [ "$w" -gt "$WIDTH" ] && WIDTH=$w
    [ "$n" -gt "$LAST" ] && LAST=$n
  fi
done
ID="$(printf '%s-%0*d' "$PREFIX" "$WIDTH" $((LAST + 1)))"
DIR="$VM/${ID}_${SLUG}"
[ ! -e "$DIR" ] || { echo "[new-fact] $DIR already exists"; exit 1; }

# YAML-format the id lists ("F-001,F-002" -> [F-001, F-002]).
yaml_list() { [ -n "$1" ] && printf '[%s]' "$(printf %s "$1" | sed 's/,/, /g')" || printf '[]'; }

mkdir -p "$DIR"
cat > "$DIR/entry.md" <<EOF
---
id: $ID
title: $SLUG
tier: $TIER
polarity: $POLARITY
depends_on: $(yaml_list "$DEPENDS")
supersedes: $(yaml_list "$SUPERSEDES")
verifier: TODO - the EXACT command that re-verifies this fact
date: $(date +%Y-%m-%d)
---

## Statement

TODO - plain language AND the formal statement.

## Proof / verification

TODO - proof sketch; what the verifier checks; list the proof artifacts copied
into this folder (Lean files / witness data / checker run).
EOF

# Append the one-liner to the ledger (under the facts list at the bottom).
LINE="- **$ID** [$TIER] $SLUG: TODO one-sentence statement → ${ID}_${SLUG}/"
printf '%s\n' "$LINE" >> "$LEDGER"

# If this supersedes an older fact, remind the operator to mark the old line.
if [ -n "$SUPERSEDES" ]; then
  echo "[new-fact] NOTE: mark the ledger line(s) for $SUPERSEDES with '(superseded by $ID)'"
fi

echo "[new-fact] created $DIR"
echo "[new-fact] appended ledger line - now:"
echo "[new-fact]   1. write the Statement + Proof sections in ${ID}_${SLUG}/entry.md"
echo "[new-fact]   2. set the verifier: field to the exact re-verify command"
echo "[new-fact]   3. copy the proof artifacts into the folder"
echo "[new-fact]   4. replace the TODO one-sentence statement in verified_math.md"
