#!/usr/bin/env bash
# Runs ON a freshly-provisioned research VM (piped in via `bash -s`). Exercises
# the ENTIRE agent lifecycle end to end: stack presence, a real codex turn, and
# the full tabs-repl command surface (start / edit / lock / model / talk /
# stop / resume) driven through the real tmux repl with a fast stub `pi`.
#
# Prints "PASS:"/"FAIL:" lines and a summary; exits non-zero on any failure.
set -u
. "$HOME/.tabs-agent.env" 2>/dev/null || true
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
SCAF="$HOME/.tabs/scaffolding"
SNAP="$HOME/snapshot"
pass=0; fail=0
ok()  { echo "  PASS: $1"; pass=$((pass+1)); }
bad() { echo "  FAIL: $1"; fail=$((fail+1)); }
hdr() { echo; echo "== $1 =="; }
loop_pid() { cat "$HOME/.tabs/agent-loop.pid" 2>/dev/null; }
alive()    { local p; p="$(loop_pid)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

# ---------- A. stack presence ----------
hdr "Stack present"
command -v pi >/dev/null && ok "pi on PATH" || bad "pi missing"
node -e 'process.exit(parseInt(process.version.slice(1),10)>=22?0:1)' 2>/dev/null \
  && ok "node >= 22 ($(node -v))" || bad "node too old ($(node -v 2>/dev/null))"
command -v npm >/dev/null && ok "npm present" || bad "npm missing"
for f in agent-loop.sh tabs-repl.sh reboot-resume.sh \
         brokers/orchestrator.py brokers/children/gpu.py brokers/children/cpu.py brokers/children/common.py \
         tools/setup.sh tools/wait.sh tools/web_search.py tools/research.py tools/lean_search.py tools/llm_client.py tools/text_operator.sh tools/new-experiment.sh tools/new-fact.sh tools/cpu-worker/index.ts \
         tools/experiment-template/rust/Cargo.toml tools/experiment-template/lean/lakefile.toml; do
  [ -e "$SCAF/$f" ] && ok "scaffolding/$f" || bad "scaffolding/$f MISSING"
done
[ ! -e "$SCAF/tools/submit-done.sh" ] && ok "no submit-done.sh (removed)" || bad "stale submit-done.sh present"
# Agent-callable tools are commands on PATH (implementations stay in scaffolding).
for c in gpu-burst cpu-burst setup.sh wait.sh web-search research-search lean-search text-operator new-experiment new-fact; do
  command -v "$c" >/dev/null && ok "$c on PATH" || bad "$c not on PATH"
done
# new-experiment forks a thin attempt (source only) and re-links shared/.
( cd "$SNAP" && new-experiment probe >/dev/null 2>&1 )
if [ -L "$SNAP/workspace/experiments/experiment_1_probe/shared" ] && [ -f "$SNAP/workspace/experiments/experiment_1_probe/scratchpad.md" ]; then
  ok "new-experiment created a thin experiment (shared symlink + scratchpad)"
  rm -rf "$SNAP/workspace/experiments/experiment_1_probe"
else
  bad "new-experiment did not fork correctly"
fi
crontab -l 2>/dev/null | grep -q reboot-resume.sh && ok "@reboot resume cron installed" || bad "reboot-resume cron missing"
[ ! -e "$SCAF/codex-activate.py" ] && ok "no legacy codex-activate.py" || bad "legacy codex-activate.py present"
for f in AGENTS.md problem.md notebook.md; do
  [ -f "$SNAP/$f" ] && ok "snapshot/$f" || bad "snapshot/$f MISSING"
done
# The snapshot is context-window only: no tool impls, no memory runtime, no skill scripts.
[ ! -e "$SNAP/tools" ] && ok "snapshot has no tools/ (moved to scaffolding)" || bad "snapshot/tools/ present"
[ -z "$(find "$SNAP/.agents/skills" -name scripts -o -name assets 2>/dev/null)" ] && ok "no skill scripts/assets in snapshot" || bad "skill scripts/assets leaked into snapshot"
[ -d "$SNAP/.agents/skills" ] && ok "skills at .agents/skills (Pi's location)" || bad ".agents/skills missing"
[ ! -e "$SNAP/skills" ] && ok "no confusing root skills alias" || bad "stray root skills/ present"
grep -q RAILWAY_BROKER_URL "$HOME/.tabs-agent.env" && ok "broker env present" || bad "broker env missing"
grep -q GITHUB_TOKEN "$HOME/.tabs-agent.env" 2>/dev/null && bad "GITHUB_TOKEN in agent env (git is retired)" || ok "no GITHUB_TOKEN anywhere in agent env"
grep -qE '^[0-9a-f]{6}$' "$HOME/.tabs/instance-id" && ok "instance-id 6 hex" || bad "instance-id malformed"

# ---------- B. Real codex turn ----------
hdr "Codex - real gpt-5.5 turn via broker"
V="$(curl -s -m 25 "$RAILWAY_BROKER_URL/token?force=1" -H "Authorization: Bearer $RAILWAY_BROKER_API_KEY")"
TOKEN="$(echo "$V" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)"
ACC="$(echo "$V" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("account_id",""))' 2>/dev/null)"
if [ -n "$TOKEN" ]; then
  python3 - "$TOKEN" "$ACC" <<'PY'
import json, os, sys, time
t, a = sys.argv[1], sys.argv[2]
p = os.path.expanduser("~/.pi/agent/auth.json")
try: auth = json.load(open(p))
except Exception: auth = {}
auth["openai-codex"] = {"type": "oauth", "access": t, "refresh": "broker",
                        "expires": int(time.time()*1000)+3000*1000, "accountId": a}
os.makedirs(os.path.dirname(p), exist_ok=True); json.dump(auth, open(p, "w")); os.chmod(p, 0o600)
PY
  OUT="$(cd "$SNAP" && timeout 150 pi -p --no-tools --provider openai-codex --model gpt-5.5:xhigh "Reply with exactly: E2E-CODEX-OK" </dev/null 2>&1)"
  echo "$OUT" | grep -q "E2E-CODEX-OK" && ok "real codex turn returned the answer" || bad "codex turn ($(echo "$OUT" | tail -1))"
else
  bad "broker vend failed ($V)"
fi

# ---------- B2. compute brokers actually reach the providers ----------
hdr "Compute brokers - live provider probes"
GPU="$(export PATH="$HOME/.local/bin:$PATH"; timeout 150 gpu-burst status 2>&1)"
echo "$GPU" | grep -qE "modal-1: (free|BUSY)" && ok "gpu-burst reaches modal-1" || bad "modal-1 unavailable ($(echo "$GPU"|grep modal-1))"
echo "$GPU" | grep -qE "modal-2: (free|BUSY)" && ok "gpu-burst reaches modal-2" || bad "modal-2 unavailable"
echo "$GPU" | grep -qE "daytona: (free|BUSY)" && ok "gpu-burst reaches daytona" || bad "daytona unavailable ($(echo "$GPU"|grep daytona))"
CPU="$(export PATH="$HOME/.local/bin:$PATH"; timeout 150 cpu-burst status 2>&1)"
echo "$CPU" | grep -qE "e2b .*(free|BUSY)" && ok "cpu-burst reaches e2b" || bad "e2b unavailable ($(echo "$CPU"|grep e2b))"
echo "$CPU" | grep -q "cloudflare" && ok "cpu-burst reports cloudflare" || bad "cloudflare missing"

# ---------- D. git fully retired (R2 run saves own persistence) --------
hdr "Git retired - nothing versioned on the VM, no credentials shipped"
[ ! -e "$SNAP/.git" ] && ok "no .git in the snapshot" || bad ".git present in the snapshot tree"
[ ! -e "$SNAP/.gitignore" ] && ok "no .gitignore in the snapshot" || bad ".gitignore present in the snapshot tree"
[ ! -e "$SCAF/github-sync.sh" ] && ok "no github-sync.sh (retired)" || bad "stale github-sync.sh present"
[ ! -e "$HOME/.tabs/github.env" ] && ok "no github.env (no PAT on the VM)" || bad "stale github.env present"
[ ! -d "$HOME/.tabs/snapshot-git" ] && ok "no external gitdir (retired)" || bad "stale snapshot-git present"

# ---------- E. lifecycle mechanics (real tabs-repl, stub pi) ----------
hdr "Lifecycle - start/edit/lock/model/talk/stop/resume/submit"
INV="$HOME/.pi-invocations.log"; : > "$INV"
# stub pi shadows real pi (~/.local/bin is first on the agent PATH). It logs
# every invocation and simulates the agent editing code, so the real repl +
# supervisor run fast and deterministically.
cat > "$HOME/.local/bin/pi" <<STUB
#!/usr/bin/env bash
echo "PI_INVOKED: \$*" >> "$INV"
mkdir -p "\$PWD/workspace" 2>/dev/null && echo "agent edit \$(date +%s)" > "\$PWD/workspace/agent_touch.txt" 2>/dev/null || true
echo '{"totalTokens":100}'
exit 0
STUB
chmod +x "$HOME/.local/bin/pi"
rm -f "$SNAP/workspace/agent_touch.txt" "$HOME/.tabs/agent-loop.pid"

tmux kill-session -t life 2>/dev/null
tmux new-session -d -s life "cd $SNAP; source \$HOME/.tabs-agent.env 2>/dev/null; $SCAF/tabs-repl.sh; exec \$SHELL" 9>&-
sleep 2
pane() { tmux capture-pane -t life -p -S -80 2>/dev/null; }

# start
tmux send-keys -t life "/start-new-agent" Enter; sleep 6
alive && ok "/start-new-agent → loop live (pid $(loop_pid))" || bad "loop not live after /start-new-agent"
[ -f "$HOME/.tabs/agent-should-run" ] && ok "should-run marker set (reboot would auto-resume)" || bad "should-run marker not set on start"
sleep 3
[ -f "$SNAP/workspace/agent_touch.txt" ] && ok "agent EDITS code while running (workspace/agent_touch.txt)" || bad "no agent edit observed"
# edit-lock signal - the exact predicate the star-fleet's session.writeFile checks
if [ -f "$HOME/.tabs/agent-loop.pid" ] && kill -0 "$(loop_pid)" 2>/dev/null; then
  ok "edit-lock signal ACTIVE (app refuses manual writes while running)"
else bad "edit-lock signal not active while running"; fi
# double start refused
tmux send-keys -t life "/start-new-agent" Enter; sleep 3
pane | grep -q "already running" && ok "double /start-new-agent refused" || bad "double start not refused"
# model switch + validation
tmux send-keys -t life "/model gpt-5.4" Enter; sleep 3
[ "$(cat "$HOME/.tabs/agent-model" 2>/dev/null)" = "gpt-5.4:xhigh" ] && ok "/model gpt-5.4 persisted" || bad "/model switch failed"
tmux send-keys -t life "/model totally-bogus" Enter; sleep 2
pane | grep -qi "not in the allowed" && ok "/model rejects an unknown model" || bad "bad model not rejected"
tmux send-keys -t life "/model gpt-5.5" Enter; sleep 2
# Saving to R2 is not a repl command (it's the app button) - the repl rejects legacy commands
tmux send-keys -t life "/upload-code-to-r2" Enter; sleep 2
pane | grep -qi "unknown command" && ok "no /upload-code-to-r2 in the repl (retired)" || bad "repl still knows a removed command"
# tier-aware window logged
grep -qE "window=400000" "$HOME/.tabs/agent-loop.log" && ok "codex tier uses 400k window" || bad "tier-aware window not logged"
# talk: /stop drops into a chat on the agent's session
SID="$(cat "$HOME/.tabs/last-session" 2>/dev/null)"
tmux send-keys -t life "/stop-recursive-loop" Enter; sleep 7
if alive; then bad "loop still alive after /stop-recursive-loop"; else ok "/stop-recursive-loop → loop stopped (edits unlocked)"; fi
[ ! -f "$HOME/.tabs/agent-should-run" ] && ok "should-run marker cleared (deliberate stop won't auto-resume)" || bad "should-run marker still set after stop"
grep -q -- "--session-id $SID" "$INV" && ok "/stop opened a CHAT on the agent's session ($SID)" || bad "chat did not open on last-session"
# resume same session
tmux send-keys -t life "/start-recursive-loop" Enter; sleep 6
alive && ok "/start-recursive-loop → loop live again" || bad "resume failed"
grep -q "resuming existing session $SID" "$HOME/.tabs/agent-loop.log" && ok "resume REATTACHES the same session" || bad "resume did not reattach session"
# the only handoff is text-operator (no submit-done); it halts on a SUCCESSFUL send
# (kills the loop pgid + clears the should-run marker). We don't fire a real text
# here (that would spam the operator), so just confirm the halt wiring is present.
grep -q 'kill -TERM -- "-$loop_pid"' "$SCAF/tools/text_operator.sh" && ok "text-operator halts the loop after sending" || bad "text-operator missing loop-halt"
grep -q 'rm -f "$HOME/.tabs/agent-should-run"' "$SCAF/tools/text_operator.sh" && ok "text-operator clears the should-run marker" || bad "text-operator missing marker clear"
[ ! -e "$SCAF/tools/submit-done.sh" ] && ok "no submit-done (text-operator is the only handoff)" || bad "stale submit-done present"

# cleanup mechanics
rm -f "$HOME/.local/bin/pi" "$SNAP/workspace/agent_touch.txt"
tmux kill-session -t life 2>/dev/null

# ---------- F. No flock leak (would deadlock the next provision) ----------
hdr "No flock leak (long-run reconnect safety)"
if command -v fuser >/dev/null 2>&1; then
  if fuser "$HOME/.tabs-provision.lock" >/dev/null 2>&1; then
    bad "provision lock still held - next reconnect/reprovision would hang"
  else ok "provision lock free (tmux daemon did not inherit fd 9)"; fi
else ok "fuser unavailable - skipped (9>&- covered by unit test)"; fi

# ---------- G. log rotation cap (2-week disk safety) ----------
hdr "Log rotation cap"
grep -q "rotate_log" "$SCAF/agent-loop.sh" && ok "supervisor rotates its log (bounded growth)" || bad "no log rotation - unbounded growth risk"

hdr "Summary"
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
