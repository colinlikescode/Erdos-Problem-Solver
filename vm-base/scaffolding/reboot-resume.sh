#!/usr/bin/env bash
# @reboot hook (installed in crontab by the provisioner). A droplet can reboot
# mid-run - DO maintenance, a kernel update, an OOM kill - and the agent's tmux
# session dies with it. For a run that may last two weeks, that must not silently
# stop the agent. So on boot, IF the agent was meant to be running, we restart
# the never-stop loop detached (the tmux UI session is recreated later, when the
# human next opens the machine in the app).
#
# The intent marker ~/.tabs/agent-should-run is set by /start-new-agent and
# /start-recursive-loop, cleared by /stop-recursive-loop and by text-operator (the
# agent's escalate-and-halt). So a deliberately-stopped or escalated agent does
# not auto-resume; only one that was actively working does.
set -u
sleep "${REBOOT_RESUME_DELAY:-15}"   # let networking + clock settle after boot (0 in tests)

MARK="$HOME/.tabs/agent-should-run"
[ -f "$MARK" ] || exit 0                     # not meant to be running → done

PIDF="$HOME/.tabs/agent-loop.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
  exit 0                                      # already running
fi
rm -f "$PIDF"                                 # stale pid from before the reboot

SNAP="$HOME/snapshot"
[ -f "$SNAP/problem.md" ] || exit 0           # no snapshot to work

cd "$SNAP" || exit 0
. "$HOME/.tabs-agent.env" 2>/dev/null || true
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
LOG="${AGENT_LOG:-$HOME/.tabs/agent-loop.log}"
echo "[reboot-resume] $(date -u +%FT%TZ) restarting the never-stop loop after a reboot" >> "$LOG"
# RESUME=1: reattach the session recorded in ~/.tabs/last-session (context via
# handoff.md/notebook.md), exactly like /start-recursive-loop.
RESUME=1 setsid "$HOME/.tabs/scaffolding/agent-loop.sh" >> "$LOG" 2>&1 &
