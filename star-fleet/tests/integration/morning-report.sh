#!/usr/bin/env bash
# Read-only digest of every research instance: what it has PROVEN (verified_math
# ledger), how hard it's working (turns / compactions / rotations), its current
# plan, and integrity (no sorry/admit in any Lean proof). Safe to run anytime  - 
# it only reads. Use to review overnight progress.
#
#   VMS="/tmp/vm1.env /tmp/vm2.env /tmp/vm3.env" bash tests/integration/morning-report.sh
set -u
CP="$(cd "$(dirname "$0")/../.." && pwd)"
VMS="${VMS:-/tmp/vm1.env /tmp/vm2.env /tmp/vm3.env}"
RN_TIMEOUT="${RN_TIMEOUT:-120}"
to() { perl -e 'my $s=shift; alarm $s; exec @ARGV or exit 127' "$@"; }
rn() { to "$RN_TIMEOUT" env E2E_VM="$1" bun "$CP/tests/integration/e2e-ssh.ts" run "$2" 2>/dev/null; }
name_of() { grep -E '^NAME=' "$1" 2>/dev/null | cut -d= -f2- || basename "$1"; }

echo "############################################################"
echo "#  TABS MORNING REPORT - $(date)"
echo "############################################################"
for vm in $VMS; do
  nm="$(name_of "$vm")"
  echo
  echo "==================== $nm ===================="
  rn "$vm" '
    echo "PROBLEM: $(head -1 ~/snapshot/problem.md)"
    p=$(cat ~/.tabs/agent-loop.pid 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "STATUS: ALIVE (turn $(ps --ppid $p -o etime= 2>/dev/null|tr -d " "|head -1))"; else echo "STATUS: STOPPED (halted or between turns)"; fi
    # halted-by-text-operator shows as: loop stopped AND the should-run intent cleared
    [ ! -f ~/.tabs/agent-should-run ] && [ -z "$p" ] && echo "NOTE: should-run cleared - likely a text-operator escalation (check your phone)"
    echo "TURNS: $(grep -ac "^----- turn" ~/.tabs/agent-loop.log) done | $(grep -ac "ec=0" ~/.tabs/agent-loop.log) ok | rotations $(grep -ac advancing ~/.tabs/agent-loop.log) | compactions $(grep -ac compacting ~/.tabs/agent-loop.log)"
    v=$(ls -d ~/snapshot/verified_math/*/ 2>/dev/null | wc -l)
    echo "VERIFIED RESULTS: $v"
    leancnt=$(find ~/snapshot/verified_math -name "*.lean" 2>/dev/null | wc -l)
    cheats=$(grep -rlE "\bsorry\b|\badmit\b" ~/snapshot/verified_math --include=*.lean 2>/dev/null | wc -l)
    echo "LEAN PROOFS: $leancnt | with sorry/admit: $cheats (want 0)"
    echo "--- verified_math entries ---"
    ls ~/snapshot/verified_math/ 2>/dev/null | grep -v verified_math.md | sed "s/^/  - /"
    echo "--- current plan (notebook) ---"
    sed -n "/Current plan/,/Attempt log/p" ~/snapshot/notebook.md 2>/dev/null | grep -vE "^\s*$|Attempt log|_\(" | head -8 | sed "s/^/  /"
  '
done
echo
echo "############################################################"
echo "#  APIs + broker pool"
echo "############################################################"
BURL=$(grep -E '^RAILWAY_BROKER_URL=' "$CP/../.env"|cut -d= -f2-); BKEY=$(grep -E '^RAILWAY_BROKER_API_KEY=' "$CP/../.env"|cut -d= -f2-)
curl -s -m 12 "$BURL/accounts" -H "Authorization: Bearer $BKEY" 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print('broker:',sum(1 for a in d['accounts'] if a['state']=='ready'),'/',len(d['accounts']),'ready')" 2>/dev/null || echo "broker: check"
