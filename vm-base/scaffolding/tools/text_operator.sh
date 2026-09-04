#!/usr/bin/env bash
# text_operator.sh [--case solved|stuck|gpu] "<message>" - text the operator via Sendblue,
# tagged with this VM's instance id so they know which machine is talking.
#
# Sanctioned uses only (see SKILL.md): 100% stuck / need a big GPU cluster /
# problem solved. --case picks the header emoji. Message body is normalized:
# literal "\n" is converted to real newlines and 3+ blank lines collapse to one,
# so the SMS always reads clean regardless of how the agent typed it.
set -u

CASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --case) CASE="${2:-}"; shift 2 ;;
    --case=*) CASE="${1#*=}"; shift ;;
    *) break ;;
  esac
done
MSG="${1:-}"
if [ -z "$MSG" ]; then
  echo "usage: text-operator [--case solved|stuck|gpu] \"<message>\"" >&2
  exit 2
fi
if [ -z "${SENDBLUE_API_KEY:-}" ] || [ -z "${SENDBLUE_API_SECRET:-}" ]; then
  echo "text_operator: SENDBLUE_API_KEY / SENDBLUE_API_SECRET not set; cannot text." >&2
  exit 2
fi
if [ -z "${OPERATOR_PHONE_NUMBER:-}" ] || [ -z "${SENDBLUE_FROM_NUMBER:-}" ]; then
  echo "text_operator: OPERATOR_PHONE_NUMBER / SENDBLUE_FROM_NUMBER not set; cannot text." >&2
  exit 2
fi

# Both numbers come from the agent env (set in the repo-root .env, E.164 format).
TO="$OPERATOR_PHONE_NUMBER"
FROM="$SENDBLUE_FROM_NUMBER"

# Header emoji per escalation case.
case "$CASE" in
  solved) HEADER="🎉✅ SOLVED" ;;
  stuck)  HEADER="🛑 STUCK" ;;
  gpu)    HEADER="✨🖥️ NEED GPUS" ;;
  *)      HEADER="" ;;
esac

# Per-VM instance tag, minted by the provisioner. Compose with real paragraph
# spacing: "[tag] HEADER" then a blank line, then the message body.
IID="$(cat "$HOME/.tabs/instance-id" 2>/dev/null || echo unknown)"

# Build + normalize the message in python: agents often type LITERAL "\n" (two
# chars) instead of real newlines, which show up ugly in the SMS. Convert
# literal \n/\r/\t to real characters, collapse 3+ blank lines to one blank
# line, trim, then prepend the "[tabs id] HEADER" line + a blank line.
BODY="$(python3 - "$FROM" "$TO" "$IID" "$HEADER" "$MSG" <<'PY'
import json, re, sys
frm, to, iid, header, msg = sys.argv[1:6]
# turn literal escape sequences into the real thing (only these three)
for a, b in (("\\r\\n", "\n"), ("\\n", "\n"), ("\\t", "\t"), ("\\r", "\n")):
    msg = msg.replace(a, b)
msg = re.sub(r"\n{3,}", "\n\n", msg).strip()
tag = f"[tabs {iid}] {header}".rstrip()
content = f"{tag}\n\n{msg}" if msg else tag
print(json.dumps({"from_number": frm, "number": to, "content": content}))
PY
)"

RESP="$(curl -sS -X POST "https://api.sendblue.co/api/send-message" \
  -H "sb-api-key-id: $SENDBLUE_API_KEY" \
  -H "sb-api-secret-key: $SENDBLUE_API_SECRET" \
  -H "Content-Type: application/json" \
  -d "$BODY")"
EC=$?

if [ $EC -ne 0 ]; then
  echo "text_operator: request failed (curl exit $EC)" >&2
  exit 1
fi
# Success is positive confirmation: Sendblue returns a status of QUEUED/SENT
# and a message_handle. Anything else (auth errors return only a "message"
# field, so the absence of "error" proves nothing) is a failure.
if echo "$RESP" | grep -qE '"status":[[:space:]]*"(QUEUED|SENT)"' \
   && echo "$RESP" | grep -q '"message_handle"'; then
  echo "text_operator: sent as [tabs $IID] (status QUEUED)"
else
  echo "text_operator: send FAILED: $RESP" >&2
  exit 1
fi

# All three escalations are "hand back to the human" moments - so texting the operator
# halts the never-stop loop until they restart it (/start-recursive-loop). Clear
# the reboot intent so it doesn't auto-resume, then stop the loop's process group
# (this kills the in-flight turn, and this script with it - the text already sent).
rm -f "$HOME/.tabs/agent-should-run" 2>/dev/null || true
loop_pid="$(cat "$HOME/.tabs/agent-loop.pid" 2>/dev/null)"
if [ -n "$loop_pid" ]; then
  echo "text_operator: halting the agent loop - the operator restarts it with /start-recursive-loop"
  kill -TERM -- "-$loop_pid" 2>/dev/null || kill -TERM "$loop_pid" 2>/dev/null || true
fi
