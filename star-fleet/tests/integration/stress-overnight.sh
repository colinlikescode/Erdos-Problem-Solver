#!/usr/bin/env bash
# Overnight, all-real stress test. Monitors the live research VMs (+ any given
# in VMS) for STRESS_HOURS, taking a health snapshot every MONITOR_INTERVAL,
# checkpointing each VM's code to R2 and re-checking every external API on a
# cadence, and SELF-HEALING a dead loop (restart, preserving its session).
# Everything is logged to $STRESS_LOG. No mocks.
#
#   VMS="/tmp/vm1.env /tmp/vm2.env /tmp/vm3.env" STRESS_HOURS=8 \
#     bash tests/integration/stress-overnight.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CP="$(cd "$HERE/../.." && pwd)"
ENVFILE="$CP/../.env"
env() { grep -E "^$1=" "$ENVFILE" | cut -d= -f2-; }
VMS="${VMS:-/tmp/vm1.env /tmp/vm2.env}"
STRESS_HOURS="${STRESS_HOURS:-8}"
MONITOR_INTERVAL="${MONITOR_INTERVAL:-300}"     # 5 min health snapshot
CHECKPOINT_EVERY="${CHECKPOINT_EVERY:-1800}"    # 30 min R2 checkpoint + progress
API_EVERY="${API_EVERY:-1800}"                  # 30 min full API recheck
LOG="${STRESS_LOG:-/tmp/stress-overnight.log}"
start=$(date +%s)
deadline=$(( start + STRESS_HOURS*3600 ))
last_ckpt=0; last_api=0

say() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG"; }
# Hard wall-clock cap (macOS has no `timeout`; perl alarm is always present) so a
# single unreachable VM can never freeze the whole overnight monitor loop.
RN_TIMEOUT="${RN_TIMEOUT:-150}"
to() { perl -e 'my $s=shift; alarm $s; exec @ARGV or exit 127' "$@"; }
rn()  { to "$RN_TIMEOUT" env E2E_VM="$1" bun "$CP/tests/integration/e2e-ssh.ts" run "$2" 2>/dev/null; }
name_of() { grep -E '^NAME=' "$1" 2>/dev/null | cut -d= -f2- || basename "$1"; }

api_check() {
  local burl bkey ok=0 tot=0
  burl="$(env RAILWAY_BROKER_URL)"; bkey="$(env RAILWAY_BROKER_API_KEY)"
  chk() { tot=$((tot+1)); if eval "$2" >/dev/null 2>&1; then ok=$((ok+1)); else say "  API DOWN: $1"; fi; }
  chk broker      "curl -sf -m 12 '$burl/health'"
  chk broker-pool "curl -sf -m 12 '$burl/accounts' -H 'Authorization: Bearer $bkey' | grep -q ready"
  chk chroma      "curl -sf -m 12 https://api.trychroma.com/api/v2/auth/identity -H 'x-chroma-token: $(env CHROMA_API_KEY)' | grep -q tenant"
  chk gemini      "curl -sf -m 20 https://generativelanguage.googleapis.com/v1beta/openai/embeddings -H 'Authorization: Bearer $(env GEMINI_API_KEY)' -H 'Content-Type: application/json' -d '{\"model\":\"gemini-embedding-2\",\"input\":\"ok\"}' | grep -q embedding"
  chk r2          "curl -sf -m 12 https://api.cloudflare.com/client/v4/accounts/$(env CLOUDFLARE_ACCOUNT_ID)/r2/buckets -H 'Authorization: Bearer $(env CLOUDFLARE_API_KEY)' | grep -q tabs-snapshots"
  chk digitalocean "curl -sf -m 12 https://api.digitalocean.com/v2/account -H 'Authorization: Bearer $(env DIGITAL_OCEAN_API_KEY)' | grep -q active"
  say "APIs: $ok/$tot healthy"
}

STALL_MIN="${STALL_MIN:-150}"   # a single pi turn longer than this = suspicious
IDLE_MIN="${IDLE_MIN:-30}"      # ...but only ALERT if NOTHING was written for this long
DISK_ALERT="${DISK_ALERT:-85}"  # ALERT if root disk usage % >= this

# elapsed "MM:SS" | "HH:MM:SS" | "D-HH:MM:SS" -> minutes
etime_min() {
  case "$1" in
    "-"|"") echo 0 ;;
    *-*) local d="${1%%-*}" r="${1#*-}"; echo $(( d*1440 + $(etime_min "$r") )) ;;
    *:*:*) local h="${1%%:*}" r="${1#*:}"; echo $(( 10#$h*60 + 10#${r%%:*} )) ;;
    *:*) echo $(( 10#${1%%:*} )) ;;
    *) echo 0 ;;
  esac
}

# One health snapshot per VM; self-heals a dead loop; flags stalls/disk.
snapshot() {
  local vm="$1" nm; nm="$(name_of "$vm")"
  local info
  info="$(rn "$vm" '
    p=$(cat ~/.tabs/agent-loop.pid 2>/dev/null)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then st="ALIVE"; turn=$(ps --ppid $p -o etime= 2>/dev/null | tr -d " " | head -1); else st="DOWN"; turn="-"; fi
    turns=$(grep -ac "^----- turn" ~/.tabs/agent-loop.log 2>/dev/null)
    ok0=$(grep -ac "ec=0" ~/.tabs/agent-loop.log 2>/dev/null)
    adv=$(grep -ac "advancing" ~/.tabs/agent-loop.log 2>/dev/null)
    comp=$(grep -ac "compacting" ~/.tabs/agent-loop.log 2>/dev/null)
    vm_ok=$(ls -d ~/snapshot/verified_math/*/ 2>/dev/null | wc -l)
    diskp=$(df / | awk "NR==2{print \$5}" | tr -d "%")
    logmb=$(( $(wc -c < ~/.tabs/agent-loop.log 2>/dev/null || echo 0) / 1000000 ))
    newest=$(find ~/snapshot -type f ! -path "*/.git/*" -printf "%T@\n" 2>/dev/null | sort -rn | head -1 | cut -d. -f1)
    if [ -n "$newest" ]; then idle=$(( ( $(date +%s) - newest ) / 60 )); else idle=9999; fi
    pi_pid=$(pgrep -x pi | head -1)
    kids=$(ps --ppid "${pi_pid:-0}" -o pid= 2>/dev/null | wc -l)
    echo "state=$st turn=${turn:--} turns=$turns ec0=$ok0 adv=$adv compactions=$comp verified=$vm_ok disk=${diskp}% logMB=$logmb idleMin=$idle kids=$kids"
  ')"
  say "  [$nm] $info"
  # dead loop -> self-heal
  if echo "$info" | grep -q "state=DOWN"; then
    say "  [$nm] ALERT: loop DOWN - self-healing (restart, preserve session)"
    rn "$vm" '
      tmux has-session -t tabs-pi 2>/dev/null || tmux new-session -d -s tabs-pi "cd ~/snapshot; source \$HOME/.tabs-agent.env 2>/dev/null; ~/.tabs/scaffolding/tabs-repl.sh; exec \$SHELL" 9>&-
      sleep 2; tmux send-keys -t tabs-pi "/start-recursive-loop" Enter; sleep 6
      kill -0 $(cat ~/.tabs/agent-loop.pid 2>/dev/null) 2>/dev/null && echo restarted || echo restart-FAILED' \
      | sed "s/^/  [$nm] heal: /" | tee -a "$LOG"
    return
  fi
  # hung-turn detector. Long turns alone are not stalls - observed healthy
  # gpt-5.5:xhigh marathon turns run 2.5-4h while writing verified results the
  # whole time. A turn is only "hung" if it's long AND the workspace has gone
  # quiet (no file written for IDLE_MIN). idleMin comes from the snapshot above.
  local t; t="$(echo "$info" | sed -nE 's/.*turn=([0-9:.-]+).*/\1/p')"
  local tmin; tmin="$(etime_min "$t")"
  local im; im="$(echo "$info" | sed -nE 's/.*idleMin=([0-9]+).*/\1/p')"
  local kd; kd="$(echo "$info" | sed -nE 's/.*kids=([0-9]+).*/\1/p')"
  # hung = long turn + quiet workspace + pi has NO live tool child (a running
  # child, e.g. a sieve or a wait.sh poll, means it's legitimately waiting).
  if [ "${tmin:-0}" -ge "$STALL_MIN" ] && [ "${im:-0}" -ge "$IDLE_MIN" ] && [ "${kd:-1}" -eq 0 ]; then
    say "  [$nm] ALERT: turn ${tmin}m, no writes ${im}m, no live tool child - likely hung pi turn"
  fi
  # disk pressure
  local dp; dp="$(echo "$info" | sed -nE 's/.*disk=([0-9]+)%.*/\1/p')"
  [ "${dp:-0}" -ge "$DISK_ALERT" ] && say "  [$nm] ALERT: disk ${dp}% >= ${DISK_ALERT}% - running low"
}

# Periodic progress capture. NOTE: this only READS state - persistence is the
# app's "Save to R2" button (which refuses while the loop runs), so the monitor
# must never save/commit on the agent's behalf.
checkpoint() {
  local vm="$1" nm; nm="$(name_of "$vm")"
  local out
  out="$(rn "$vm" '
    echo "verified=$(ls -d ~/snapshot/verified_math/*/ 2>/dev/null | wc -l)"
    echo "notebook_tail:"; tail -c 400 ~/snapshot/notebook.md 2>/dev/null | tr "\n" " " | tail -c 400
  ')"
  say "  [$nm] PROGRESS $out"
}

say "===================================================================="
say "OVERNIGHT STRESS START - ${STRESS_HOURS}h, VMs: $VMS"
say "===================================================================="
api_check; last_api=$(date +%s)
for vm in $VMS; do checkpoint "$vm"; done; last_ckpt=$(date +%s)

hour_mark=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  now=$(date +%s); elapsed_h=$(( (now-start)/3600 ))
  if [ "$elapsed_h" -gt "$hour_mark" ]; then
    hour_mark=$elapsed_h
    say "---------- PHASE: ${elapsed_h}h elapsed ----------"
  fi
  for vm in $VMS; do snapshot "$vm"; done
  now=$(date +%s)
  if [ $(( now - last_api )) -ge "$API_EVERY" ]; then api_check; last_api=$now; fi
  if [ $(( now - last_ckpt )) -ge "$CHECKPOINT_EVERY" ]; then for vm in $VMS; do checkpoint "$vm"; done; last_ckpt=$(date +%s); fi
  sleep "$MONITOR_INTERVAL"
done

say "===================================================================="
say "OVERNIGHT STRESS COMPLETE (${STRESS_HOURS}h). Final snapshot:"
api_check
for vm in $VMS; do snapshot "$vm"; checkpoint "$vm"; done
say "DONE."
