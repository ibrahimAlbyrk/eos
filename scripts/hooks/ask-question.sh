#!/bin/bash
# Eos PreToolUse hook for AskUserQuestion.
#
# Blocks on /workers/:id/question until web UI provides answers, then
# returns a deny with answers in the message so Claude sees the user's
# responses without the TUI multi-question input flow.
set -uo pipefail

input=$(cat)

# Not daemon-aware — let it through
if [ -z "${CLAUDE_MGR_SPAWNED:-}" ] || \
   [ -z "${CLAUDE_MGR_DAEMON_URL:-}" ] || \
   [ -z "${CLAUDE_MGR_WORKER_ID:-}" ]; then
  exit 0
fi

# Extract questions and toolUseId from hook input
q_body=$(printf '%s' "$input" | jq -c '{questions: .tool_input.questions, toolUseId: .tool_use_id}' 2>/dev/null || echo "")
if [ -z "$q_body" ]; then
  exit 0
fi

# POST to daemon — blocks until web UI answers (max 1 hour)
resp=$(curl -sS --max-time 3600 -X POST \
  -H 'content-type: application/json' \
  -d "$q_body" \
  "${CLAUDE_MGR_DAEMON_URL}/workers/${CLAUDE_MGR_WORKER_ID}/question" 2>/dev/null || true)

answers=$(printf '%s' "$resp" | jq -c '.answers // empty' 2>/dev/null || echo "")
if [ -z "$answers" ]; then
  exit 0
fi

# Build the deny message with answers formatted as bullet points
msg=$(printf '%s' "$answers" | jq -r '
  "User answered via web UI:\n" +
  (to_entries | map("- " + .key + ": " + .value) | join("\n")) +
  "\nUse these answers and continue."
')

# Use jq to construct the full JSON output safely
printf '%s' "$msg" | jq -Rs '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    decision: {
      behavior: "deny",
      message: .
    }
  }
}'
exit 0
