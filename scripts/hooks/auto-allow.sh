#!/bin/bash
# Eos PermissionRequest hook.
#
# Two modes:
#   1. Daemon-aware: when worker.ts spawns claude with CLAUDE_MGR_SPAWNED=1,
#      CLAUDE_MGR_DAEMON_URL=<url>, and CLAUDE_MGR_WORKER_ID=<id>, this script
#      forwards the request body to <url>/policy/decide and returns the
#      daemon's Decision verbatim, wrapped in the hookSpecificOutput envelope
#      Claude expects.
#   2. Standalone: when those env vars are missing (interactive claude
#      sessions started outside the daemon), the script auto-allows so the
#      hook is invisible. AskUserQuestion always falls through to Claude's
#      interactive prompt regardless of mode.
#
# The envelope shape is the one CLAUDE.md documents:
#   { hookSpecificOutput: {
#       hookEventName: "PermissionRequest",
#       decision: { behavior, message? },
#       updatedInput?: { ... }   // sibling of decision, NOT inside it
#   }}
#
# Requires jq + curl (both standard on macOS via Homebrew and on most Linux
# distros). Daemon round-trip is bounded by --max-time 90s; this comfortably
# exceeds the daemon's default policy.ttlMs of 30s so the daemon's TTL
# auto-deny fires before curl times out.
set -uo pipefail

input=$(cat)

# Always fall through to Claude's interactive AskUserQuestion prompt — the
# daemon has no UI affordance for that flow today.
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
if [ "$tool_name" = "AskUserQuestion" ]; then
  echo '{}'
  exit 0
fi

# Daemon-aware path. Three env vars all required — missing any one falls
# through to the safe standalone allow.
if [ -n "${CLAUDE_MGR_SPAWNED:-}" ] && \
   [ -n "${CLAUDE_MGR_DAEMON_URL:-}" ] && \
   [ -n "${CLAUDE_MGR_WORKER_ID:-}" ] && \
   [[ "${CLAUDE_MGR_DAEMON_URL:-}" =~ ^https?:// ]]; then
  body=$(printf '%s' "$input" \
    | jq -c --arg wid "$CLAUDE_MGR_WORKER_ID" \
        '{worker_id: $wid, tool_name: .tool_name, input: (.tool_input // {}), tool_use_id: (.tool_use_id // null)}' \
        2>/dev/null || echo "")
  if [ -n "$body" ]; then
    decision=$(curl -sS --max-time 90 -X POST \
      -H 'content-type: application/json' \
      -d "$body" \
      "${CLAUDE_MGR_DAEMON_URL}/policy/decide" 2>/dev/null || true)
    # Validate the response shape before wrapping. If the daemon returned
    # something unparseable / missing .behavior, treat as failure and fall
    # through to the standalone default (allow). The daemon's ask + TTL
    # mechanism handles human approval inside the long-poll, so we never
    # have to synthesize an "ask" decision here.
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

# Standalone / fallback default — allow. Matches the behavior of the legacy
# user-side script and keeps non-daemon claude sessions unaffected.
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
exit 0
