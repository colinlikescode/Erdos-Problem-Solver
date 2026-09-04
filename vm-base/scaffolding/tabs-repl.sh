#!/usr/bin/env bash
# tabs-repl - what the agent sidebar drops you into (inside tmux, cwd = the
# snapshot folder). The autonomous run does not start by itself.
#
# The human interface:
#   /start-new-agent       initialize Pi on this problem and start the
#                          recursive never-stop loop (fresh bootstrap)
#   /stop-recursive-loop   stop the loop (kills the in-flight turn). While
#                          stopped, manual file edits are allowed AND any plain
#                          text you type is a chat message to the agent (one
#                          turn on its saved session), streamed to the sidebar.
#   /start-recursive-loop  reactivate the never-stop loop ("please continue";
#                          same session state via handoff/notebook files)
#   /reject "<why>"        after the agent hands back a solution (text-operator) you
#                          judge wrong: tell it why and resume - it takes the
#                          rejection as ground truth and keeps working, deciding
#                          itself when to try you again.
#   /model [<model>]       show or switch the model the loop runs (persisted to
#                          ~/.tabs/agent-model; takes effect next turn). The
#                          allowed models come from the codex-broker's /models
#                          list (CODEX_MODELS), so new models roll out fleet-wide
#                          with no VM change. Default gpt-5.5:xhigh.
#
# (Saving the run to R2 is not a repl command - it's the desktop app's
# top-right "Save to R2" button, and it refuses while the loop is running, so
# a save can never capture files mid-edit. The agent never touches storage.)
#
# The loop runs in the background (its own process group, pid in
# ~/.tabs/agent-loop.pid), so this prompt stays live while the agent works.
# While the loop is running the star-fleet app refuses manual file edits  - 
# /stop-recursive-loop first, edit/chat, then /start-recursive-loop.
# When stopped, plain text is a chat message to the agent; prefix with `!` to
# run a raw shell command (e.g. `!cat problem.md`).
set -u

SCAFFOLD_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${AGENT_LOG:-$HOME/.tabs/agent-loop.log}"
PIDFILE="${AGENT_PIDFILE:-$HOME/.tabs/agent-loop.pid}"
MODEL_FILE="${AGENT_MODEL_FILE:-$HOME/.tabs/agent-model}"
# The app's Agent sidebar streams this transcript. The repl appends its own
# status + chat events here so the sidebar reflects stop/start and manual chat
# (not just the autonomous loop's turns). Same JSONL the supervisor writes.
THINK_FILE="${AGENT_THINK_FILE:-$HOME/.tabs/agent-thinking.jsonl}"
THINK_PARSER="${AGENT_THINK_PARSER:-$HOME/.tabs/think-stream.py}"

# Append one transcript event ({"k","v","t"}) for the sidebar to render.
tmeta() {
  python3 - "$THINK_FILE" "$1" "$2" <<'PY' 2>/dev/null || true
import json, sys, time
open(sys.argv[1], "a", encoding="utf-8").write(
    json.dumps({"k": sys.argv[2], "v": sys.argv[3][:6000], "t": time.time()}) + "\n")
PY
}
# Intent marker: "the agent is SUPPOSED to be running." Set when a run starts,
# cleared when the human stops it. The @reboot hook (reboot-resume.sh) uses this
# to auto-restart the loop after a droplet reboot - but only if it was actively
# working, so a deliberately-stopped agent stays stopped.
SHOULD_RUN="$HOME/.tabs/agent-should-run"
DEFAULT_MODEL="gpt-5.5:xhigh"

loop_running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

current_model() {
  { [ -s "$MODEL_FILE" ] && head -1 "$MODEL_FILE" | tr -d '[:space:]'; } || echo "$DEFAULT_MODEL"
}

# The allowed models come from the codex-broker (GET /models), so a new model
# (e.g. gpt-5.6) rolls out fleet-wide by setting CODEX_MODELS on that one
# Railway service - no VM redeploy. Falls back to a built-in safe set if the
# broker is unreachable, so you can never get locked out of the known models.
FALLBACK_MODELS="gpt-5.4 gpt-5.5"
allowed_models() {
  local list=""
  if [ -n "${RAILWAY_BROKER_URL:-}" ] && [ -n "${RAILWAY_BROKER_API_KEY:-}" ]; then
    list="$(curl -sS -m 8 "$RAILWAY_BROKER_URL/models" -H "Authorization: Bearer $RAILWAY_BROKER_API_KEY" 2>/dev/null \
      | python3 -c 'import json,sys
try: print(" ".join(json.load(sys.stdin).get("models",[])))
except Exception: pass' 2>/dev/null)"
  fi
  [ -n "$list" ] && echo "$list" || echo "$FALLBACK_MODELS"
}

# /model               -> show the model the loop will use + the allowed list
# /model <model>[:thinking] -> switch it (bare model gets :xhigh); the model must
#                         be in the broker's allowlist.
cmd_model() {
  local arg="$1" models; models="$(allowed_models)"
  if [ -z "$arg" ]; then
    echo "tabs: agent model = $(current_model)"
    echo "tabs: available (from broker): $models"
    return 0
  fi
  local base="${arg%%:*}" spec="$arg" ok=0
  for m in $models; do [ "$m" = "$base" ] && ok=1; done
  if [ "$ok" -ne 1 ]; then
    echo "tabs: '$base' is not in the allowed list: $models"
    echo "tabs: (to add a model fleet-wide, set CODEX_MODELS on the codex-broker.)"
    return 1
  fi
  [ "$spec" = "$base" ] && spec="$base:xhigh"   # bare model → xhigh, matching the default
  mkdir -p "$(dirname "$MODEL_FILE")"
  printf '%s\n' "$spec" > "$MODEL_FILE"
  echo "tabs: agent model set to $spec."
  if loop_running; then
    echo "tabs: takes effect on the loop's NEXT turn. (For an immediate switch:"
    echo "      /stop-recursive-loop then /start-recursive-loop.)"
  else
    echo "tabs: /start-recursive-loop (or /start-new-agent) will use it."
  fi
}

# /reject "<why>" - the agent handed back a solution (text-operator) that you've
# judged wrong/incomplete. Drop a one-shot reject note the supervisor reads on
# its next start, then resume the loop. The agent takes it as ground truth and
# keeps working; it decides when to try texting you again.
REJECT_NOTE="$HOME/.tabs/reject-note"
cmd_reject() {
  local why="$1"
  if loop_running; then
    echo "tabs: the loop is still running - /reject is for after the agent hands back"
    echo "      a solution (the loop halts on text-operator). Nothing to reject right now."
    return 1
  fi
  mkdir -p "$(dirname "$REJECT_NOTE")"
  printf '%s\n' "$why" > "$REJECT_NOTE"
  echo "tabs: recorded rejection. Resuming the agent - it'll take '${why:-(no reason)}' as"
  echo "      ground truth and keep working."
  launch_loop 1
}

banner() {
  echo ""
  echo "  Tabs research VM - $(basename "$PWD")"
  if loop_running; then
    echo "  Agent status: WORKING (recursive loop active - manual edits locked)"
  elif [ -f ./problem.md ]; then
    echo "  Agent status: stopped. Edit problem.md, then /start-new-agent."
  else
    echo "  NOTE: no problem.md here - this folder is not a research snapshot."
  fi
  echo ""
  echo "    /start-new-agent       initialize Pi + start the never-stop loop"
  echo "    /stop-recursive-loop   stop the loop and chat with the agent"
  echo "    /start-recursive-loop  resume the never-stop loop"
  echo "    /reject \"<why>\"        reject a handed-back solution + resume working"
  echo "    /model [<model>]       show/switch the model (current: $(current_model))"
  echo ""
  echo "  To talk to the agent, edit files, or switch models: /stop-recursive-loop"
  echo "  first, then /start-recursive-loop when you're done. Anything else"
  echo "  you type runs as a shell command."
  echo ""
}

# Start the supervisor detached in its own process group so the prompt stays
# live and /stop-recursive-loop can kill the loop AND its in-flight pi turn.
launch_loop() {
  if [ ! -f ./problem.md ]; then
    echo "tabs: no problem.md in $(pwd) - open the snapshot folder first." >&2
    return 1
  fi
  if loop_running; then
    echo "tabs: the loop is already running (pid $(cat "$PIDFILE")). /stop-recursive-loop first."
    return 1
  fi
  mkdir -p "$(dirname "$SHOULD_RUN")" && : > "$SHOULD_RUN"   # mark: meant to be running (survives reboot)
  RESUME="$1" setsid "$SCAFFOLD_DIR/agent-loop.sh" >>"$LOG" 2>&1 &
  sleep 1
  if loop_running; then
    echo "tabs: recursive loop is LIVE (pid $(cat "$PIDFILE")) - the agent never stops"
    echo "tabs: manual file edits are now locked; /stop-recursive-loop to intervene."
  else
    echo "tabs: loop failed to start - tail of $LOG:" >&2
    tail -n 8 "$LOG" 2>/dev/null | sed 's/^/  /' >&2
    return 1
  fi
}

cmd_stop() {
  rm -f "$SHOULD_RUN"   # deliberate stop: do not auto-resume on reboot
  if ! loop_running; then
    echo "tabs: the loop is not running."
    tmeta meta "Recursive loop already stopped. Type a message to chat with the agent; /start-recursive-loop to resume."
    return 0
  fi
  local pid; pid="$(cat "$PIDFILE")"
  echo "tabs: stopping the recursive loop (pid $pid) + any in-flight turn..."
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do loop_running || break; sleep 1; done
  if loop_running; then
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    rm -f "$PIDFILE"
  fi
  echo "tabs: loop stopped. Manual edits are unlocked. Type a message to chat."
  # Surface the stop IN the SIDEBAR (which streams the transcript, not this pane).
  tmeta meta "Recursive loop stopped - manual edits unlocked. Type a message to chat with the agent; /start-recursive-loop to resume."
}

# Chat with the agent while the loop is stopped. Runs one json-mode turn on the
# saved session and streams the reply (say/think/tool) into the transcript the
# sidebar tails - so both your message and the agent's answer show up there.
cmd_chat() {
  local msg="$1" sid=""
  [ -f "$HOME/.tabs/last-session" ] && sid="$(cat "$HOME/.tabs/last-session")"
  tmeta user "$msg"
  local args=(-p --mode json)
  [ -n "$sid" ] && args=(--session-id "$sid" "${args[@]}")
  # Prefer the ChatGPT-account provider (the loop's creds in auth.json); fall
  # back to the regular OpenAI key if that errors. Stream through the same
  # parser the supervisor uses so the sidebar renders it identically.
  if ! pi "${args[@]}" --provider openai-codex "$msg" </dev/null 2>&1 \
       | tee -a "$LOG" | python3 "$THINK_PARSER" "$THINK_FILE"; then
    pi "${args[@]}" --provider openai "$msg" </dev/null 2>&1 \
       | tee -a "$LOG" | python3 "$THINK_PARSER" "$THINK_FILE" || \
       tmeta err "chat failed - no working provider (broker token may have lapsed; /start-recursive-loop re-vends)"
  fi
}

banner
trap ':' INT
while true; do
  if ! read -r -e -p "tabs> " line; then echo; exec ${SHELL:-bash}; fi
  case "$(echo "$line" | xargs 2>/dev/null || echo "$line")" in
    "") ;;
    "/start-new-agent") launch_loop 0 ;;
    "/stop-recursive-loop") cmd_stop ;;
    "/start-recursive-loop") launch_loop 1 ;;
    "/reject"|"/reject "*)
      why="$(echo "$line" | sed -E 's#^/reject[[:space:]]*##; s#^"(.*)"$#\1#')"
      cmd_reject "$why" ;;
    "/model"|"/model "*) cmd_model "$(echo "$line" | sed -E 's#^/model[[:space:]]*##')" ;;
    "!"*) bash -c "${line#!}" ;;   # !<cmd> runs a raw shell command
    /*)
      echo "tabs: unknown command. Commands:"
      echo "  /start-new-agent | /stop-recursive-loop | /start-recursive-loop | /reject | /model"
      ;;
    # Plain text = a message to the agent. Only allowed while the loop is
    # stopped (running = edits/chat locked). Streams into the sidebar transcript.
    *)
      if loop_running; then
        echo "tabs: the loop is running - /stop-recursive-loop before chatting. (!cmd for a shell command.)"
      else
        cmd_chat "$line"
      fi
      ;;
  esac
done
