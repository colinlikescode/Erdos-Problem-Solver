#!/usr/bin/env bash
#
# Live end-to-end integration tests against the real test droplet.
# Exercises the whole stack the app provisions: Pi + its OpenAI extensions,
# Pi settings (compaction/trust) and auth seeding, the compute brokers,
# (Gemini + Chroma Cloud), per-VM identity files, the never-stop supervisor,
# and the raw Gemini endpoints.
#
# Requires network + the droplet SSH key. Skips (exit 0) if the key is absent so
# it never breaks CI on machines without droplet access.
#
#   KEY=/path/to/key.pem HOST=ubuntu@<droplet-ip> bash tests/integration/live.sh
set -u

KEY="${KEY:-/tmp/tabs-key.pem}"
HOST="${HOST:-}"
if [ -z "$HOST" ]; then echo "HOST not set (e.g. HOST=ubuntu@1.2.3.4); skipping live tests"; exit 0; fi
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$HOST")
# ROOT = star-fleet/ (the app project); IMAGE = vm-base/ (VM-side).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="$(cd "$ROOT/../vm-base" && pwd)"
ENVFILE="$ROOT/../.env"

pass=0; fail=0
ok()   { echo "  PASS: $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $1"; fail=$((fail+1)); }
hdr()  { echo; echo "== $1 =="; }

if [ ! -f "$KEY" ]; then
  echo "[live] SSH key $KEY not found - skipping live integration tests."
  exit 0
fi
if ! "${SSH[@]}" true 2>/dev/null; then
  echo "[live] cannot reach $HOST - skipping live integration tests."
  exit 0
fi

REMOTE_ENV='source "$HOME/.tabs-agent.env" 2>/dev/null; export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH";'

# --- 0. Gemini raw endpoints (search-tool embeddings backend) ----------------
hdr "Gemini endpoints"
GEMINI_KEY="$(grep -E '^GEMINI_API_KEY=' "$ENVFILE" 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -n "${GEMINI_KEY:-}" ]; then
  emb="$(curl -sS -m 30 https://generativelanguage.googleapis.com/v1beta/openai/embeddings \
    -H "Authorization: Bearer $GEMINI_KEY" -H "Content-Type: application/json" \
    -d '{"model":"gemini-embedding-2","input":"hello"}' 2>/dev/null)"
  echo "$emb" | grep -q '"embedding"' && ok "gemini-embedding-2" || bad "gemini embeddings ($(echo "$emb" | head -c 80))"
else
  echo "  SKIP: no GEMINI_API_KEY in .env"
fi

# --- 1. Provisioning (generate from app code, run, idempotent) ---------------
hdr "Provisioning"
( cd "$ROOT" && bun tests/integration/gen-provision.ts /tmp/tabs-provision.sh >/dev/null ) \
  && ok "generated provision script from app code" || bad "gen-provision"
r1="$("${SSH[@]}" 'bash -s' < /tmp/tabs-provision.sh 2>&1 | tail -1)"
echo "$r1" | grep -q '\[tabs\] ready' && ok "provision run 1 -> ready" || bad "provision run 1 ($r1)"
r2="$("${SSH[@]}" 'bash -s' < /tmp/tabs-provision.sh 2>&1 | tail -1)"
echo "$r2" | grep -q '\[tabs\] ready' && ok "provision run 2 -> ready (idempotent)" || bad "provision run 2 ($r2)"

# --- 2. Pi install + settings + auth seeding ---------------------------------
hdr "Pi config"
"${SSH[@]}" "$REMOTE_ENV command -v pi >/dev/null" && ok "pi on PATH" || bad "pi not on PATH"
cfg="$("${SSH[@]}" 'cat ~/.pi/agent/settings.json' 2>/dev/null)"
echo "$cfg" | grep -q '"compaction"' && ok "compaction settings merged" || bad "compaction missing ($cfg)"
echo "$cfg" | grep -q '"defaultProjectTrust": "always"' && ok "project trust set" || bad "project trust missing"
auth="$("${SSH[@]}" 'cat ~/.pi/agent/auth.json' 2>/dev/null)"
echo "$auth" | grep -q '"openai"' && ok "openai auth seeded" || bad "openai auth missing"
# Codex auth lives only in the codex-broker - nothing codex may exist on disk.
"${SSH[@]}" 'test ! -e ~/.pi/agent/codex-accounts.json && ! grep -q openai-codex ~/.pi/agent/auth.json' \
  && ok "no codex credentials on disk (broker owns them)" || bad "stale codex credentials found on VM"
"${SSH[@]}" 'source ~/.tabs-agent.env; [ -n "$RAILWAY_BROKER_URL" ] && curl -s -m 10 "$RAILWAY_BROKER_URL/health" | grep -q "\"ok\":true"' \
  && ok "codex-broker reachable from the VM" || bad "broker unreachable from VM"

# --- 3. Per-VM identity files -------------------------------------------------
hdr "Per-VM identity"
iid="$("${SSH[@]}" 'cat ~/.tabs/instance-id' 2>/dev/null)"
echo "$iid" | grep -qE '^[0-9a-f]{6}$' && ok "instance-id is 6 hex chars ($iid)" || bad "instance-id malformed ($iid)"
# --- 4b. Edit-lock signal (the app refuses writes while the loop runs) --------
hdr "Edit lock (agent-loop.pid)"
# Same check session.ts runs before every manual file write.
GUARD='if [ -f "$HOME/.tabs/agent-loop.pid" ] && kill -0 "$(cat "$HOME/.tabs/agent-loop.pid")" 2>/dev/null; then echo WORKING; fi'
lock="$("${SSH[@]}" "
  sleep 60 & echo \$! > ~/.tabs/agent-loop.pid
  $GUARD
  kill \$(cat ~/.tabs/agent-loop.pid) 2>/dev/null; rm -f ~/.tabs/agent-loop.pid
  $GUARD; echo END")"
echo "$lock" | grep -q '^WORKING$' && ok "live pid file reads WORKING (writes would be refused)" || bad "edit-lock guard broken ($lock)"
echo "$lock" | grep -A1 WORKING | grep -q '^END$' && ok "cleared pid file unlocks writes" || bad "unlock broken ($lock)"

# --- 5. Never-stop supervisor (deterministic stub) ----------------------------
# The real provision installs the supervisor at ~/.tabs/scaffolding (outside the
# agent's workspace); the stub run mirrors that: script outside, cwd = snapshot.
hdr "Never-stop supervisor (scaffolding)"
"${SSH[@]}" 'test -x ~/.tabs/scaffolding/agent-loop.sh' \
  && ok "provision installed ~/.tabs/scaffolding/agent-loop.sh" \
  || bad "scaffolding not installed by provision"
scp -i "$KEY" -o StrictHostKeyChecking=no "$IMAGE/scaffolding/agent-loop.sh" "$HOST:/tmp/agent-loop.sh" >/dev/null 2>&1
loop="$("${SSH[@]}" '
  D=$(mktemp -d); mkdir -p "$D/bin" "$D/work/tools" "$D/home" "$D/scaffolding"
  printf "%s\n" "#!/usr/bin/env bash" "echo \"STUB pi: \$*\"" "exit 0" > "$D/bin/pi"; chmod +x "$D/bin/pi"
  for f in AGENTS.md problem.md notebook.md; do echo x > "$D/work/$f"; done
  mkdir -p "$D/work/verified_math" && echo x > "$D/work/verified_math/verified_math.md"
  cp /tmp/agent-loop.sh "$D/scaffolding/"; chmod +x "$D/scaffolding/agent-loop.sh"
  cd "$D/work"; HOME="$D/home" PATH="$D/bin:/usr/bin:/bin" AGENT_LOG="$D/log" OPENAI_API_KEY=stub-key \
    timeout 10 "$D/scaffolding/agent-loop.sh" >/dev/null 2>&1
  echo "turns=$(grep -c "run provider=openai" "$D/log")"
  echo "first=$(grep -c "start solving" "$D/log")"
  echo "continue=$(grep -c "please continue solving the problem" "$D/log")"
  grep -q "STUB pi: --session-id" "$D/log" && echo "flags=ok" || echo "flags=bad"
  grep -q "mode json" "$D/log" && echo "json=ok" || echo "json=bad"
  rm -rf "$D" /tmp/agent-loop.sh
' 2>&1)"
echo "$loop" | grep -q 'flags=ok' && ok "supervisor drives pi with --session-id" || bad "supervisor flags ($loop)"
echo "$loop" | grep -q 'json=ok' && ok "supervisor uses json mode (context tracking)" || bad "json mode ($loop)"
t="$(echo "$loop" | sed -n 's/^turns=//p')"; [ "${t:-0}" -ge 2 ] 2>/dev/null && ok "supervisor re-invokes ($t turns)" || bad "re-invoke count ($t)"
echo "$loop" | grep -q 'first=[1-9]' && ok "first turn bootstraps" || bad "first prompt ($loop)"
echo "$loop" | grep -q 'continue=[1-9]' && ok "re-invoke uses 'please continue' prompt" || bad "continue prompt ($loop)"

# --- summary ------------------------------------------------------------------
hdr "Summary"
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
