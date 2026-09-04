#!/usr/bin/env bash
#
# The sanctioned pause tool. When the agent genuinely needs to wait - a long
# build, a rate-limit reset, a background search job - it calls this instead of
# stopping. Waiting is one of the only two allowed states (see AGENTS.md §0):
# keep working, or wait. Never just stop.
#
# Installed on PATH by the provisioner. Usage:
#   wait.sh [seconds] ["reason"]
#
# Examples:
#   wait.sh 60 "waiting for lake build"
#   wait.sh 900 "rate limit reset"
set -u

secs="${1:-30}"
reason="${2:-waiting}"

echo "[wait] pausing ${secs}s: ${reason}"
sleep "$secs"
echo "[wait] resuming work"
