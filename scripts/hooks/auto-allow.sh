#!/bin/bash
# Eos PermissionRequest hook.
#
# Daemon-aware: forwards to /policy/decide. AskUserQuestion: denied outright —
# its native menu has no answer surface in Eos (the orchestrator asks the
# operator via mcp__orchestrator__ask_user instead). Standalone: auto-allows
# everything else.
set -uo pipefail

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")

# Keep the message in sync with blockedBuiltinToolMessage("AskUserQuestion") in
# contracts/src/tool-scope.ts (PreToolUse + step-0 enforce the same deny). The
# other blocked builtin (Workflow) is stripped from the model surface via
# --disallowedTools, so it never reaches this PermissionRequest hook.
if [ "$tool_name" = "AskUserQuestion" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"AskUserQuestion is disabled in Eos — its native menu has no answer surface here. Orchestrator: ask the operator via mcp__orchestrator__ask_user. Worker: proceed on your best judgment or report `needs input: <ask>` to your parent."}}}'
  exit 0
fi

# Daemon-aware path for regular tools
if [ -n "${EOS_SPAWNED:-}" ] && \
   [ -n "${EOS_DAEMON_URL:-}" ] && \
   [ -n "${EOS_WORKER_ID:-}" ] && \
   [[ "${EOS_DAEMON_URL:-}" =~ ^https?:// ]]; then
  body=$(printf '%s' "$input" \
    | jq -c --arg wid "$EOS_WORKER_ID" \
        '{worker_id: $wid, tool_name: .tool_name, input: (.tool_input // {}), tool_use_id: (.tool_use_id // null), agent_id: (.agent_id // null)}' \
        2>/dev/null || echo "")
  if [ -n "$body" ]; then
    # One curl process per tool call cannot pool connections, so over TCP each
    # decision burned an ephemeral port that then sat in TIME_WAIT — thousands of
    # tool calls saturate the local port range and then EVERY connect() on the
    # machine fails with EADDRNOTAVAIL. The unix socket costs no port; the TCP
    # URL stays as the fallback for when the socket isn't there.
    if [ -n "${EOS_DAEMON_SOCK:-}" ] && [ -S "${EOS_DAEMON_SOCK}" ]; then
      decision=$(curl -sS --max-time "${EOS_POLICY_TIMEOUT_SEC:-3600}" -X POST \
        --unix-socket "${EOS_DAEMON_SOCK}" \
        -H 'content-type: application/json' \
        -d "$body" \
        "http://localhost/policy/decide" 2>/dev/null || true)
    fi
    if [ -z "${decision:-}" ]; then
      decision=$(curl -sS --max-time "${EOS_POLICY_TIMEOUT_SEC:-3600}" -X POST \
        -H 'content-type: application/json' \
        -d "$body" \
        "${EOS_DAEMON_URL}/policy/decide" 2>/dev/null || true)
    fi
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
