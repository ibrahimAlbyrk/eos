#!/bin/bash
# Eos PermissionRequest hook.
#
# Daemon-aware: forwards to /policy/decide. AskUserQuestion: fire-and-forget
# POST to /workers/:id/question-notify to surface the web banner, then returns
# no decision so Claude renders its native menu. Standalone: auto-allows everything.
set -uo pipefail

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")

# AskUserQuestion: surface the question as a web banner (fire-and-forget) and
# return no decision so Claude renders its native menu. The web UI answers by
# simulating keystrokes into that menu — Claude's PermissionRequest updatedInput
# channel cannot pre-fill AskUserQuestion answers, so we must NOT block here.
if [ "$tool_name" = "AskUserQuestion" ]; then
  if [ -n "${CLAUDE_MGR_SPAWNED:-}" ] && \
     [ -n "${CLAUDE_MGR_DAEMON_URL:-}" ] && \
     [ -n "${CLAUDE_MGR_WORKER_ID:-}" ]; then
    q_body=$(printf '%s' "$input" | jq -c 'select(.tool_input.questions | type == "array") | {questions: .tool_input.questions, toolUseId: .tool_use_id}' 2>/dev/null || echo "")
    if [ -n "$q_body" ]; then
      curl -sS --max-time 5 -X POST \
        -H 'content-type: application/json' \
        -d "$q_body" \
        "${CLAUDE_MGR_DAEMON_URL}/workers/${CLAUDE_MGR_WORKER_ID}/question-notify" >/dev/null 2>&1 || true
    fi
  fi
  echo '{}'
  exit 0
fi

# Daemon-aware path for regular tools
if [ -n "${CLAUDE_MGR_SPAWNED:-}" ] && \
   [ -n "${CLAUDE_MGR_DAEMON_URL:-}" ] && \
   [ -n "${CLAUDE_MGR_WORKER_ID:-}" ] && \
   [[ "${CLAUDE_MGR_DAEMON_URL:-}" =~ ^https?:// ]]; then
  body=$(printf '%s' "$input" \
    | jq -c --arg wid "$CLAUDE_MGR_WORKER_ID" \
        '{worker_id: $wid, tool_name: .tool_name, input: (.tool_input // {}), tool_use_id: (.tool_use_id // null)}' \
        2>/dev/null || echo "")
  if [ -n "$body" ]; then
    decision=$(curl -sS --max-time "${CLAUDE_MGR_POLICY_TIMEOUT_SEC:-3600}" -X POST \
      -H 'content-type: application/json' \
      -d "$body" \
      "${CLAUDE_MGR_DAEMON_URL}/policy/decide" 2>/dev/null || true)
    wrapped=$(printf '%s' "$decision" | jq -c '
      if (type == "object") and (.behavior != null) and (.behavior == "allow" or .behavior == "deny") then {
        hookSpecificOutput: ({
          hookEventName: "PermissionRequest",
          decision: (
            { behavior: .behavior }
            + (if .message then { message: .message } else {} end)
          )
        } + (if .updatedInput then { updatedInput: .updatedInput } else {} end))
      } else empty end
    ' 2>/dev/null || echo "")
    if [ -n "$wrapped" ]; then
      printf '%s' "$wrapped"
      exit 0
    fi
  fi
fi

# Standalone / fallback — allow
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
exit 0
