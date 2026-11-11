---
description: Daemon safety-net nudge to a worker that reached IDLE having never reported this life
variables:
  - SEND_MESSAGE_TO_PARENT_TOOL
---
Your turn ended but you never called `{{SEND_MESSAGE_TO_PARENT_TOOL}}`, so the orchestrator received nothing — your transcript is not a report. Call `{{SEND_MESSAGE_TO_PARENT_TOOL}}` now, first line one of: `result: <one-line headline>`, `needs input: <one-line ask>`, or `failed: <one-line reason>`. If the work is done, report `result:` with the outcome, artifacts, and (in a worktree) the Handover line. If it is unfinished or blocked, do NOT fake completion — report `needs input:` with the one decision or missing thing you need, or `failed:` if it is impossible as framed. If you already reported this turn or this was a direct operator chat reply, ignore this. Report once, then stop.
