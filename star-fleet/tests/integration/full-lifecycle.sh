#!/usr/bin/env bash
# FULL end-to-end lifecycle test on a real, freshly-spun DigitalOcean droplet:
#
#   spin (real spinupDroplet) -> provision (real, twice = idempotency) ->
#   remote-lifecycle.sh (stack + real codex turn + full repl surface) ->
#   durability across a real ssh disconnect -> destroy the droplet.
#
# Run from star-fleet/:  bash tests/integration/full-lifecycle.sh
# Env: KEEP=1 keeps the droplet (skip teardown) for debugging.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CP="$(cd "$HERE/../.." && pwd)"
ENVFILE="$CP/../.env"
DO_TOKEN="$(grep -E '^DIGITAL_OCEAN_API_KEY=' "$ENVFILE" | cut -d= -f2-)"
VMENV=/tmp/vm-life.env
export E2E_NAME=tabs-lifecycle E2E_PROBLEM_FILE=/tmp/life-problem.txt E2E_OUT="$VMENV" E2E_PROVISION=/tmp/prov-life.sh E2E_VM="$VMENV"
cat > /tmp/life-problem.txt <<'EOF'
Lifecycle self-test problem: determine whether P = NP. (This VM is a throwaway
integration-test box; the agent is driven by a stub during mechanics checks.)
EOF

say() { echo; echo "########## $1 ##########"; }
ssh_run()    { ( cd "$CP" && bun tests/integration/e2e-ssh.ts run "$1" ); }
ssh_script() { ( cd "$CP" && bun tests/integration/e2e-ssh.ts script "$1" ); }

teardown() {
  [ "${KEEP:-0}" = "1" ] && { echo "KEEP=1 - leaving droplet up ($(grep IP= "$VMENV" 2>/dev/null))"; return; }
  say "TEARDOWN"
  local ids
  ids="$(curl -s -m 20 "https://api.digitalocean.com/v2/droplets?per_page=200" -H "Authorization: Bearer $DO_TOKEN" \
    | python3 -c "import json,sys;[print(d['id']) for d in json.load(sys.stdin).get('droplets',[]) if d['name']=='tabs-lifecycle']" 2>/dev/null)"
  for id in $ids; do
    curl -s -m 20 -X DELETE "https://api.digitalocean.com/v2/droplets/$id" -H "Authorization: Bearer $DO_TOKEN" \
      -o /dev/null -w "destroyed droplet $id: %{http_code}\n"
  done
}
trap teardown EXIT

say "SPIN a fresh DigitalOcean droplet"
( cd "$CP" && bun tests/integration/e2e-spin.ts ) || { echo "spin failed"; exit 1; }
IP="$(grep IP= "$VMENV" | cut -d= -f2)"
echo "droplet IP: $IP"

say "PROVISION (run 1)"
ssh_script /tmp/prov-life.sh | tail -3

say "IDEMPOTENCY - sentinel survives a second provision"
SENT="sentinel-$RANDOM"
ssh_run "echo $SENT > ~/snapshot/.e2e-sentinel; echo seeded"
ssh_script /tmp/prov-life.sh | tail -2
GOT="$(ssh_run 'cat ~/snapshot/.e2e-sentinel 2>/dev/null' | tr -d '\r\n ')"
if [ "$GOT" = "$SENT" ]; then echo "  PASS: reprovision preserved the snapshot (idempotent)"; else echo "  FAIL: sentinel lost ($GOT != $SENT)"; FAILED=1; fi
ssh_run 'rm -f ~/snapshot/.e2e-sentinel' >/dev/null

say "REMOTE LIFECYCLE SUITE"
if ssh_script "$HERE/remote-lifecycle.sh"; then REMOTE_OK=1; else REMOTE_OK=0; fi

say "DURABILITY - loop survives a full SSH disconnect"
# Start a stub-pi loop whose 'turn' sleeps, so a live child spans the disconnect.
ssh_run '
  cat > ~/.local/bin/pi <<STUB
#!/usr/bin/env bash
echo "{\"totalTokens\":100}"
sleep 180
exit 0
STUB
  chmod +x ~/.local/bin/pi
  rm -f ~/.tabs/agent-loop.pid
  tmux kill-session -t dur 2>/dev/null
  tmux new-session -d -s dur "cd ~/snapshot; source \$HOME/.tabs-agent.env 2>/dev/null; ~/.tabs/scaffolding/tabs-repl.sh; exec \$SHELL" 9>&-
  sleep 2; tmux send-keys -t dur "/start-new-agent" Enter; sleep 4
  echo "started pid=$(cat ~/.tabs/agent-loop.pid 2>/dev/null)"' | tail -1
echo "  ...disconnected. Sleeping 40s with ZERO connections to the VM..."
sleep 40
DUR="$(ssh_run 'kill -0 $(cat ~/.tabs/agent-loop.pid 2>/dev/null) 2>/dev/null && echo ALIVE || echo DEAD; rm -f ~/.local/bin/pi; pkill -f "sleep 180" 2>/dev/null; tmux kill-session -t dur 2>/dev/null; true' | grep -oE 'ALIVE|DEAD' | head -1)"
if [ "$DUR" = "ALIVE" ]; then echo "  PASS: loop survived a full SSH disconnect (tmux daemon under systemd)"; else echo "  FAIL: loop died across disconnect ($DUR)"; FAILED=1; fi

say "RESULT"
if [ "${REMOTE_OK:-0}" = "1" ] && [ "${FAILED:-0}" != "1" ]; then
  echo "FULL LIFECYCLE: ALL GREEN"
  exit 0
else
  echo "FULL LIFECYCLE: FAILURES ABOVE (remote_ok=${REMOTE_OK:-0} local_failed=${FAILED:-0})"
  exit 1
fi
