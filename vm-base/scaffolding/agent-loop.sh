#!/usr/bin/env bash
#
# Never-stop supervisor for the Pi agent, with OpenAI provider failover AND a
# context-window handoff/compaction protocol.
#
# FAILOVER - strict fallback order, exhausting each before the next:
#   1. The codex-broker (RAILWAY_BROKER_URL): per-turn access tokens for the
#      pooled ChatGPT accounts, then the big-budget reserve - the broker decides
#      which (tier codex-oauth / codex-oauth-reserve). Written into auth.json as
#      Pi's `openai-codex` (ChatGPT-account) credential. Only the broker
#      refreshes (VMs never hold refresh tokens - see codex-broker-railway/README.md).
#   2. Regular OpenAI key      (provider `openai`, OPENAI_API_KEY) - last resort.
# Every tier runs through the same run_tier: same model (gpt-5.5:xhigh), same
# json-mode context tracking, same 90% handoff->compact protocol, same prompts.
# The tier only changes where the credential comes from.
#
# STOP PROTOCOL - the loop is infinite; it never stops on its own. The agent's
# only way to hand back to the human is the text-operator skill (3 escalations:
# stuck / needs a huge GPU cluster / SOLVED). text-operator sends the text and then
# kills this loop's process group + clears the reboot intent, so the VM idles
# until the operator runs /start-recursive-loop. There is no submit-done / .submitted.
#
# CONTEXT PROTOCOL - every turn runs in --mode json so we can read the session's
# token count. When context reaches HANDOFF_PCT (default 90%) of the window we:
#   1. stop normal work and make the agent write a rigorous handoff.md,
#   2. "compact" by rotating to a fresh Pi session (context reset; handoff.md +
#      verified_math/ + notebook.md carry the state forward), and
#   3. bootstrap the fresh session by telling the agent to study the codebase and
#      read handoff.md/verified_math/notebook.md, then continue - so it never gets
#      mixed up across the reset. (Pi's own auto-compaction stays on as a
#      within-turn safety net; see ~/.pi/agent/settings.json.)
#
#   ~/.tabs/scaffolding/agent-loop.sh    (run with cwd = the snapshot root)
#
# SCAFFOLDING, not SNAPSHOT: this script is installed OUTSIDE the agent's
# working world by the star fleet's provisioner - Pi can't see or edit the
# machinery that drives it. It operates on whatever snapshot directory it is
# started in (the tmux session cd's there first).
#
# Env overrides: AGENT_LOG, PI_MODEL, PI_CONTEXT_WINDOW,
# HANDOFF_PCT, COOLDOWN_SECS, MAX_TIER_ERRORS.
set -u

ROOT="$(pwd)"
if [ ! -f "$ROOT/problem.md" ]; then
  echo "[agent-loop] $ROOT does not look like a snapshot (no problem.md); refusing to start." >&2
  exit 1
fi

LOG="${AGENT_LOG:-$HOME/.tabs/agent-loop.log}"
COOLDOWN_SECS="${COOLDOWN_SECS:-300}"
MAX_TIER_ERRORS="${MAX_TIER_ERRORS:-3}"
mkdir -p "$(dirname "$LOG")"

# the "agent is working" signal. tabs-repl uses it for /stop-recursive-loop &
# to refuse double-starts, and the star-fleet app refuses manual file edits
# while this pid is alive (the human must /stop-recursive-loop first).
PIDFILE="${AGENT_PIDFILE:-$HOME/.tabs/agent-loop.pid}"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "[agent-loop] already running (pid $(cat "$PIDFILE")); refusing to double-start." >&2
  exit 1
fi
mkdir -p "$(dirname "$PIDFILE")"
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
trap 'rm -f "$PIDFILE"; exit 143' INT TERM

[ -f "$HOME/.tabs-agent.env" ] && . "$HOME/.tabs-agent.env"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# Model + thinking for every OpenAI provider. Default gpt-5.5 at xhigh.
# The human can switch models (e.g. to gpt-5.4) between runs: /stop-recursive-loop,
# then `/model gpt-5.4` in tabs-repl writes ~/.tabs/agent-model, and the next
# /start-recursive-loop picks it up. resolve_model() is read fresh each turn, so
# a switch also takes effect on the next turn of an already-running loop.
MODEL_FILE="${AGENT_MODEL_FILE:-$HOME/.tabs/agent-model}"
resolve_model() {
  local m=""
  [ -s "$MODEL_FILE" ] && m="$(head -1 "$MODEL_FILE" | tr -d '[:space:]')"
  [ -n "$m" ] || m="${PI_MODEL:-gpt-5.5:xhigh}"
  echo "$m"
}
PI_MODEL="$(resolve_model)"

# Effective context window (tokens), per PROVIDER+MODEL - the same model has a
# different usable window depending on where we hit it:
#   - openai (raw OpenAI API): gpt-5.5 / gpt-5.4 expose ~1M
#   - openai-codex (ChatGPT Codex backend): ~400k. (Measured: a
#     real gpt-5.5:xhigh turn ran to ~260k tokens with NO pi auto-compaction,
#     so pi's real window here is well above 272k; 400k matches the observed
#     capacity and our clean handoff at 90% fires just before pi's own
#     auto-compaction would.) Two backstops make the exact number non-critical:
#     pi's within-turn auto-compaction (settings.json reserveTokens) and
#     context_overflow() below (compact on a hard backend reject).
# PI_CONTEXT_WINDOW overrides everything (per-VM tuning once you know real limits).
HANDOFF_PCT="${HANDOFF_PCT:-90}"
context_window_for() {
  local provider="$1" model="${2%%:*}"
  if [ -n "${PI_CONTEXT_WINDOW:-}" ]; then echo "$PI_CONTEXT_WINDOW"; return; fi
  case "$provider" in
    openai)
      case "$model" in
        gpt-5.5|gpt-5.4) echo 1000000 ;;
        *) echo 400000 ;;
      esac ;;
    *) echo 400000 ;;   # ChatGPT Codex backend (openai-codex)
  esac
}

FIRST_PROMPT="Read AGENTS.md, problem.md, verified_math/verified_math.md, and \
notebook.md, then start solving the problem. If the toolchain is not set up yet \
(no Lean/Rust), run setup.sh first - it is idempotent. Work inside \
workspace/experiments/ (run new-experiment to start/fork an attempt); build the \
answer checker in check_answer/ FIRST if it is empty. Never stop working: either \
keep going or, if you must pause, run wait.sh. Record verified results ONLY in \
verified_math/ (one subfolder per proven lemma/theorem + a verified_math.md \
entry). The only time you hand back to the human is the text-operator skill (stuck, \
need a huge GPU cluster, or SOLVED) - that texts the operator and stops you; otherwise \
never stop."

# The continue nudge must restate the STOP PROTOCOL: a resumed agent that has
# ALREADY solved the problem would otherwise re-verify forever without ever
# texting the operator (seen on a real run).
CONTINUE_PROMPT="please continue solving the problem. If the problem is already \
solved and verified, do NOT keep re-verifying: follow the STOP PROTOCOL - use \
the text-operator skill (case: solved) to tell the operator now; it halts the loop."

# First-turn prompt when this snapshot CONTINUES a saved run (the app restores
# the run's cargo from R2 and drops ~/.tabs/continue-codebase). The agent is on
# 3rd base: orient and resume, do not restart or rebuild.
CONTINUE_CODEBASE_PROMPT="You are CONTINUING a long-running research program that \
already exists in this snapshot - you are on 3rd base, NOT starting over. First \
orient: read AGENTS.md, problem.md, handoff.md, verified_math/verified_math.md \
(the already-verified lemmas/theorems/proofs - build on these, NEVER re-derive \
them), notebook.md (the plan + dead ends), and the most recent \
workspace/experiments/experiment_N (the live work). If the toolchain is not set \
up yet, run setup.sh (idempotent). Then resume from exactly where handoff.md and \
notebook.md say the work stopped - continue the live experiment or fork a new one \
with new-experiment. Do NOT restart from experiment_1, do NOT rebuild \
check_answer if it already exists, do NOT re-prove anything already in \
verified_math/. Never stop: keep going or, if you must pause, run wait.sh. The \
only handback is the text-operator skill (stuck, need a huge GPU cluster, or \
SOLVED)."

HANDOFF_PROMPT="You are about to run out of context. STOP all other work right \
now and rewrite handoff.md so a FRESH agent with no memory of this session can \
resume seamlessly. Make it a rigorous, complete technical handoff: the goal and \
current status; what is DONE and VERIFIED (cite verified_math/verified_math.md \
entries); the current approach and why; what has been RULED OUT and why (dead \
ends); the exact next steps; the key files and where everything lives; and \
precisely how to build/run/verify. Be thorough and precise - this document is the \
only memory that survives. Edit ONLY handoff.md, then stop."

RESUME_PROMPT="Fresh session after a context compaction. First STUDY the codebase \
and read AGENTS.md, handoff.md, verified_math/verified_math.md, and notebook.md to \
fully reload context. Then continue solving the problem from exactly where \
handoff.md says you left off. Do not restart from scratch and do not stop."

# RESUME=1 (set by tabs-repl's /start-recursive-loop) skips the bootstrap prompt and
# goes straight to "please continue" - the files carry the state. A brand-new run
# gets FIRST_PROMPT (fresh base snapshot) OR the continue-codebase prompt when this
# snapshot was cloned from an existing repo (marker written by the provisioner).
# A one-shot reject note (from tabs-repl's /reject) wins over everything: the
# human looked at the last hand-back and it was wrong - tell the agent why and
# let it decide how to fix and when to try the operator again.
REJECT_NOTE="$HOME/.tabs/reject-note"
if [ -f "$REJECT_NOTE" ]; then
  reject_why="$(cat "$REJECT_NOTE" 2>/dev/null)"; rm -f "$REJECT_NOTE"
  pending="Human review: the solution you last handed back (text-operator) was REJECTED as \
wrong or incomplete. Reason from the operator: ${reject_why:-（none given）}. Take this as ground \
truth - you did NOT solve it. Figure out where it went wrong, adjust, and keep working. Do \
NOT text the operator again until you have genuinely fixed it and re-verified against \
check_answer/Lean; you decide when it is truly ready to send."
elif [ "${RESUME:-0}" = "1" ]; then
  pending="$CONTINUE_PROMPT"
elif [ -f "$HOME/.tabs/continue-codebase" ]; then
  pending="$CONTINUE_CODEBASE_PROMPT"
else
  pending="$FIRST_PROMPT"
fi
backoff=3
SID=""
LAST_EC=0
LAST_TOKENS=0
LAST_OUT=""
LAST_ERR=""

# Append-only to $LOG. Not `tee` - tabs-repl already redirects the loop's
# stdout into $LOG, so tee-ing to stdout too would double every line.
log() { echo "[agent-loop] $(date -u +%FT%TZ) $*" >> "$LOG"; }

# Clean, human-readable transcript for the app's Agent panel (Cursor-style).
# One JSON event per line: {"k":"turn|say|think|tool|toolres|err|meta","v":...}.
# do_turn's parser writes say/think/tool/err from pi's json; the supervisor
# writes turn/meta markers. The raw $LOG stays for debugging; this is the pretty
# feed the UI streams.
THINK_FILE="${AGENT_THINK_FILE:-$HOME/.tabs/agent-thinking.jsonl}"
think() {  # think <kind> <text>
  python3 - "$THINK_FILE" "$1" "$2" <<'PY' 2>/dev/null || true
import json, sys, time
f, k, v = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    open(f, "a", encoding="utf-8").write(json.dumps({"k": k, "v": v[:6000], "t": time.time()}) + "\n")
except Exception:
    pass
PY
}

# LIVE transcript parser: pi's json event stream is piped through this during
# the turn (see do_turn), so the app shows every assistant message, thought,
# tool call, and tool result as it happens - not after the turn ends (turns can
# run for hours). Built against pi's observed json mode schema:
#   message_update            -> streaming deltas (huge volume) - skipped
#   message_end / turn_end    -> full assistant message: content items of type
#                               "text" (prose) and "thinking" (reasoning)
#   tool_execution_start      -> {toolName, args}
#   tool_execution_end        -> {toolName, result.content[].text}
# The same assistant message shows up in both message_end and turn_end, so
# emits are deduped on (kind, text).
THINK_PARSER="$HOME/.tabs/think-stream.py"
mkdir -p "$HOME/.tabs"
cat > "$THINK_PARSER" <<'PYEOF'
import json, sys, time
out_path = sys.argv[1]
seen = set()

def emit(k, v, cap=6000, dedup=False):
    if v is None: return
    s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    s = s.strip()
    if not s: return
    if dedup:
        # turn_end re-carries the final assistant message that message_end
        # already delivered - drop the exact repeat. Tool events fire once per
        # call, so they are never deduped (repeating a command is real signal).
        key = (k, s)
        if key in seen: return
        seen.add(key)
    try:
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({"k": k, "v": s[:cap], "t": time.time()}) + "\n")
    except Exception:
        pass

def handle_assistant(m):
    if not isinstance(m, dict) or m.get("role") != "assistant": return
    for c in m.get("content") or []:
        if not isinstance(c, dict): continue
        ct = str(c.get("type", ""))
        if ct in ("text", "output_text"):
            emit("say", c.get("text"), dedup=True)
        elif ct in ("reasoning", "thinking"):
            emit("think", c.get("text") or c.get("thinking") or c.get("summary"), dedup=True)
        # toolCall content items are skipped: tool_execution_start already
        # reports every call with cleaner fields.

def tool_result_text(result):
    if isinstance(result, str): return result
    if isinstance(result, dict):
        parts = [c.get("text", "") for c in result.get("content") or []
                 if isinstance(c, dict) and c.get("type") in ("text", "output_text")]
        return "\n".join(p for p in parts if p)
    return None

def main():
    for ln in sys.stdin:
        ln = ln.strip()
        if not ln or ln[0] != "{": continue
        try: d = json.loads(ln)
        except Exception: continue
        t = str(d.get("type", ""))
        if t == "message_update":
            continue
        if t in ("message_end", "turn_end"):
            handle_assistant(d.get("message"))
        elif t == "tool_execution_start":
            name = d.get("toolName") or "tool"
            args = d.get("args")
            emit("tool", str(name) + ((" " + json.dumps(args, ensure_ascii=False)) if args else ""), cap=800)
        elif t == "tool_execution_end":
            txt = tool_result_text(d.get("result"))
            if txt: emit("toolres", txt, cap=1200)
        elif t == "error":
            e = d.get("errorMessage") or d.get("message")
            if isinstance(e, str): emit("err", e, cap=600)

try:
    main()
except Exception:
    pass
# Always drain stdin so pi/tee never die on a broken pipe mid-turn.
try:
    for _ in sys.stdin: pass
except Exception:
    pass
PYEOF

# 2-week-run safety: the log gains ~3KB/turn, so over weeks it would grow without
# bound and could fill the disk. Cap it - keep the most recent half when it passes
# the cap. Called once per turn (cheap: one wc).
LOG_MAX_BYTES="${AGENT_LOG_MAX_BYTES:-20000000}"   # ~20 MB
rotate_log() {
  local sz; sz=$(wc -c < "$LOG" 2>/dev/null || echo 0)
  if [ "${sz:-0}" -gt "$LOG_MAX_BYTES" ]; then
    tail -c "$(( LOG_MAX_BYTES / 2 ))" "$LOG" > "$LOG.rot" 2>/dev/null && mv "$LOG.rot" "$LOG"
    log "[log rotated - kept last $(( LOG_MAX_BYTES / 2 )) bytes]"
  fi
  # Keep the UI transcript bounded too (whole JSONL lines).
  local tl; tl=$(wc -l < "$THINK_FILE" 2>/dev/null || echo 0)
  if [ "${tl:-0}" -gt 20000 ]; then
    tail -n 12000 "$THINK_FILE" > "$THINK_FILE.rot" 2>/dev/null && mv "$THINK_FILE.rot" "$THINK_FILE"
  fi
}

# Persist the session id so tabs-repl's /stop-recursive-loop chat opens the same
# conversation the supervisor is driving.
new_session() {
  SID="tabs-$(date +%s)-$$-$RANDOM"
  mkdir -p "$HOME/.tabs" && echo "$SID" > "$HOME/.tabs/last-session"
}

# Fetch one token from the codex-broker. Prints
# "tier<TAB>label<TAB>account_id<TAB>token" on success, nothing on failure
# (broker down / 503 / api-key tier - the api-key tier is skipped here because
# tier 3 below already uses the direct key). $1=1 forces a fresh access token
# (used after a 401: ChatGPT can invalidate outstanding tokens early).
broker_token() {
  [ -n "${RAILWAY_BROKER_URL:-}" ] && [ -n "${RAILWAY_BROKER_API_KEY:-}" ] || return 1
  curl -sS -m 25 "$RAILWAY_BROKER_URL/token?force=${1:-0}" -H "Authorization: Bearer $RAILWAY_BROKER_API_KEY" 2>/dev/null \
    | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if d.get("tier", "").startswith("codex-oauth") and d.get("access_token"):
    # tier <TAB> label <TAB> account_id <TAB> expires_at(ms) <TAB> access_token
    print("\t".join([d["tier"], d.get("label","?"), d.get("account_id",""),
                     str(d.get("expires_at","")), d["access_token"]]))
'
}

# Write a broker-vended access token into ~/.pi/agent/auth.json as pi's native
# `openai-codex` OAuth credential - pi's ChatGPT-account provider, which drives
# the same backend that answers our raw calls.
# $3 = the token's real expires_at (ms). We honor it (minus a 2-min skew) so pi
# knows when to stop using it; pi CANNOT self-refresh (refresh is broker-managed),
# so when it lapses the turn errors, should_advance()/pre-turn re-vend gets a
# fresh one. Fallback: 55 min if the broker didn't report an expiry.
write_codex_cred() {
  python3 - "$1" "$2" "${3:-}" <<'PY' 2>/dev/null || true
import json, os, sys, time
access, acct, exp = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    expires = int(exp) - 120000          # honor real TTL, minus 2-min skew
    if expires <= int(time.time()*1000): raise ValueError
except Exception:
    expires = int(time.time()*1000) + 55*60*1000
p = os.path.expanduser("~/.pi/agent/auth.json")
try:
    a = json.load(open(p))
except Exception:
    a = {}
cred = {"type": "oauth", "access": access, "refresh": "broker-managed", "expires": expires}
if acct:
    cred["accountId"] = acct
a["openai-codex"] = cred
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(a, open(p, "w"), indent=2)
os.chmod(p, 0o600)
PY
}

# Disk heads-up: on a weeks-long run the workspace (build dirs, experiments) can
# creep toward full. When the root filesystem passes DISK_WARN_PCT (default 90%),
# append a one-line warning to the turn so the agent cleans up (drop stale build
# output / dead experiments) before it wedges. Advisory only - never blocks.
DISK_WARN_PCT="${DISK_WARN_PCT:-90}"
disk_warn() {
  local pct
  pct="$(df -P / 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')"
  [ -n "$pct" ] || return 0
  if [ "$pct" -ge "$DISK_WARN_PCT" ]; then
    printf 'DISK WARNING: the VM root filesystem is %s%% full. Free space now - delete stale build output (target/, .lake/, .venv/, caches) and dead experiments in workspace/experiments/ - before it stalls your work.' "$pct"
  fi
}

# Classify pi's OWN error message (LAST_ERR) - not the raw turn output. Raw
# output contains the agent's text and tool results (web-search hits, file reads,
# command output), which over a long run WILL contain words like "rate limit" or
# "context length"; grepping that would spuriously rotate accounts / compact.
# do_turn parses pi's structured json and puts only the provider errorMessage in
# LAST_ERR, so these classifiers see just the real failure reason.

# Advance to the next provider when it is out of capacity OR can't authenticate.
should_advance() {
  printf '%s' "$1" | grep -qiE \
    "rate.?limit|quota|insufficient_quota|\b429\b|usage limit|too many requests|resets? (at|in)|no capacity|overloaded|\
no api key|no credentials|unauthorized|\b401\b|invalid_grant|authentication (failed|error)|token (expired|invalid|invalidated)|refresh (failed|token)|rejected_by_access_enforcement|access enforcement"
}

# The turn failed because the context is too long -> compact (handoff -> fresh
# session) on the same provider, don't fail over.
context_overflow() {
  printf '%s' "$1" | grep -qiE \
    "context.?length|maximum context|context window|too many tokens|reduce the length|input is too long|context_length_exceeded|prompt is too long|maximum.{0,20}tokens"
}

# Run one turn (json mode). Sets LAST_EC (1 iff pi's OWN result errored),
# LAST_TOKENS (usage high-water), LAST_ERR (pi's error message only), LAST_OUT.
do_turn() {
  local provider="$1" model="$2" msg="$3" ec
  LAST_OUT="$(mktemp)"
  LAST_EC=0; LAST_TOKENS=0; LAST_ERR=""
  # tee the raw json to LAST_OUT (for error/usage classification after the
  # turn) AND live-parse it into the UI transcript as events arrive.
  pi --session-id "$SID" -p --mode json --provider "$provider" --model "$model" "$msg" </dev/null 2>&1 \
    | tee "$LAST_OUT" | python3 "$THINK_PARSER" "$THINK_FILE"
  ec=${PIPESTATUS[0]}
  # Parse pi's structured events with python (stdlib). We look only at assistant
  # message stopReason/errorMessage and top-level harness "error" events - never
  # tool results or the agent's prose.
  eval "$(python3 - "$LAST_OUT" "$ec" "$THINK_FILE" <<'PY' 2>/dev/null
import json, sys, time
path, ec, think_path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
stop = ""; err = ""; toks = 0; saw = False
try:
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
except Exception:
    lines = []
def walk(o):
    global toks
    if isinstance(o, dict):
        v = o.get("totalTokens")
        if isinstance(v, int) and v > toks: toks = v
        for x in o.values(): walk(x)
    elif isinstance(o, list):
        for x in o: walk(x)
for ln in lines:
    ln = ln.strip()
    if not ln or ln[0] != "{": continue
    try: d = json.loads(ln)
    except Exception: continue
    saw = True
    walk(d)
    m = d.get("message") if isinstance(d.get("message"), dict) else None
    if m and m.get("role") == "assistant":
        if m.get("stopReason"): stop = m["stopReason"]
        if m.get("errorMessage"): err = m["errorMessage"]
    if d.get("type") == "error":
        stop = "error"
        e = d.get("errorMessage") or d.get("message") or err
        err = json.dumps(e) if isinstance(e, (dict, list)) else (e or err)
crash = (ec != 0 and not saw)
if crash:
    stop = stop or "error"; err = err or ("pi exited %d with no output" % ec)
failed = 1 if (stop == "error" or crash) else 0
# Surface real failures in the UI transcript (say/think/tool come from the
# LIVE parser during the turn - see THINK_PARSER).
if failed and err:
    try:
        open(think_path, "a", encoding="utf-8").write(
            json.dumps({"k": "err", "v": err[:600], "t": time.time()}) + "\n")
    except Exception:
        pass
def q(s): return "'" + str(s).replace("'", "'\\''") + "'"
print("LAST_EC=%d" % failed)
print("LAST_TOKENS=%d" % toks)
print("LAST_ERR=%s" % q(err[:600]))
PY
)"
  LAST_EC="${LAST_EC:-0}"; LAST_TOKENS="${LAST_TOKENS:-0}"; LAST_ERR="${LAST_ERR:-}"
  { echo "----- turn provider=$provider model=$model tokens=$LAST_TOKENS ec=$LAST_EC ${LAST_ERR:+err=[${LAST_ERR:0:120}]} -----"
    sed 's/\x1b\[[0-9;]*m//g' "$LAST_OUT" | tail -c 3000; echo; } >> "$LOG"
}

# Write handoff.md (same session, still has full context) then reset to a fresh
# session bootstrapped to study the codebase + handoff. This is our compaction.
# $3 = the effective context window used for the % log line.
do_handoff_and_compact() {
  local provider="$1" model="$2" window="$3" reason="${4:-}"
  log "compacting${reason:+ ($reason)}: context ~$(( LAST_TOKENS * 100 / window ))% of ${window} (>=${HANDOFF_PCT}%) - writing handoff.md, then fresh session"
  think meta "Context ~$(( LAST_TOKENS * 100 / window ))% full - writing handoff.md and compacting to a fresh session."
  do_turn "$provider" "$model" "$HANDOFF_PROMPT"
  rm -f "$LAST_OUT"
  new_session
  pending="$RESUME_PROMPT"
  log "compaction complete (fresh session $SID); next turn studies codebase + handoff.md"
}

# Run turns on one provider. Returns 2 (unavailable) or 3 (too many errors) to
# advance; never returns while turns succeed. Handles the context protocol.
run_tier() {
  local provider="$1" errors=0 mem msg model window
  while true; do
    rotate_log
    [ -n "$SID" ] || new_session
    # Re-read the model each turn so a human /model switch (while stopped, or
    # even mid-run) takes effect on the very next turn. Every tier/turn uses it.
    model="$(resolve_model)"
    window="$(context_window_for "$provider" "$model")"
    log "run provider=$provider model=$model window=$window session=$SID"
    think turn "$model"
    msg="$pending"
    # Disk heads-up if the VM is filling up (advisory).
    dw="$(disk_warn)" || dw=""
    [ -n "$dw" ] && { msg="$msg

$dw"; log "disk warning appended (root >= ${DISK_WARN_PCT}%)"; }
    do_turn "$provider" "$model" "$msg"
    rm -f "$LAST_OUT"
    # Classify only pi's own error message (LAST_ERR), never the raw turn text.
    if [ "$LAST_EC" -ne 0 ] && context_overflow "$LAST_ERR"; then
      log "provider=$provider hit context overflow - compacting instead of advancing"
      do_handoff_and_compact "$provider" "$model" "$window" "overflow"
      continue
    fi
    if [ "$LAST_EC" -ne 0 ] && should_advance "$LAST_ERR"; then
      log "provider=$provider unavailable (rate-limit/auth); advancing"; think meta "Provider rate-limited/unavailable - rotating credentials."; return 2
    fi
    if [ "$LAST_EC" -ne 0 ]; then
      errors=$(( errors + 1 ))
      if [ "$errors" -ge "$MAX_TIER_ERRORS" ]; then log "provider=$provider failed ${errors}x; advancing"; return 3; fi
      log "turn exit=$LAST_EC (error ${errors}/${MAX_TIER_ERRORS}); backing off ${backoff}s"
      sleep "$backoff"; backoff=$(( backoff < 60 ? backoff * 2 : 60 )); continue
    fi
    errors=0; backoff=3
    pending="$CONTINUE_PROMPT"
    if [ "$(( LAST_TOKENS * 100 / window ))" -ge "$HANDOFF_PCT" ]; then
      do_handoff_and_compact "$provider" "$model" "$window"
    fi
    sleep 3
  done
}

log "supervisor starting (model=$PI_MODEL; failover: broker pool+reserve -> regular OpenAI key; handoff at ${HANDOFF_PCT}%)"
# The transcript marker must say why the supervisor is starting: every
# /start-recursive-loop (resume) restarts this process, and an unqualified
# "Agent started" mid-feed reads as random noise.
if [ "${RESUME:-0}" = "1" ]; then
  think meta "Loop resumed - continuing where it left off (model $PI_MODEL)."
else
  think meta "Agent started fresh on this problem (model $PI_MODEL)."
fi
# /start-recursive-loop reattaches the session the run was paused in (full
# context intact); a fresh /start-new-agent mints a new one.
if [ "${RESUME:-0}" = "1" ] && [ -s "$HOME/.tabs/last-session" ]; then
  SID="$(cat "$HOME/.tabs/last-session")"
  log "resuming existing session $SID"
else
  new_session
fi
# How many broker accounts to burn through before conceding the whole pool is
# rate-limited and falling to the regular OpenAI tier (the broker can't see
# usage limits, only auth health, so the VM cycles until tokens work again).
BROKER_MAX_CYCLES="${BROKER_MAX_CYCLES:-12}"

while true; do
  # Tier 1: the codex-broker (pool round-robin, then the reserve - the broker
  # picks; we just consume). The vended ChatGPT OAuth access token is written
  # into auth.json as pi's `openai-codex` credential (see write_codex_cred).
  # After a 401 the next fetch uses force=1: ChatGPT sometimes invalidates
  # outstanding access tokens early, so the broker's cached copy must be
  # re-minted rather than re-served.
  cycles=0 force=0
  while [ "$cycles" -lt "$BROKER_MAX_CYCLES" ]; do
    vend="$(broker_token "$force")" || break
    [ -n "$vend" ] || break
    tier="${vend%%$'\t'*}"; rest="${vend#*$'\t'}"
    label="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
    acct_id="${rest%%$'\t'*}"; rest="${rest#*$'\t'}"
    exp="${rest%%$'\t'*}"; token="${rest#*$'\t'}"
    log "tier=broker account=$label ($tier)"
    write_codex_cred "$token" "$acct_id" "$exp"
    run_tier "openai-codex"
    force=1  # run_tier only returns on failure; be aggressive about freshness
    cycles=$(( cycles + 1 ))
  done
  # Tier 2 (last resort): the regular OpenAI API key.
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    log "tier=openai (regular key)"
    run_tier "openai"
  fi
  log "all OpenAI providers exhausted; cooling down ${COOLDOWN_SECS}s then retrying from the broker"
  sleep "$COOLDOWN_SECS"
done
