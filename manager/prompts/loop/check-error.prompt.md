---
description: Neutral re-arm delivered to a looped worker when the automated goal check itself failed (indeterminate verdict) — not a judgment on the work
variables:
  - GOAL_SUMMARY
---
The automated goal-check could not run this time — the check infrastructure (the judge or evidence collection) failed. This is NOT a judgment on your work; nothing was actually evaluated.

Goal: {{GOAL_SUMMARY}}

You do not need to change anything in response to this. When you are next idle, briefly re-report your result the normal way — call send_message_to_parent with `result: ...` — to re-arm the check. If the check keeps failing, the loop will end and surface the infrastructure problem to the orchestrator.

Do NOT just stop — a silent stop sends nothing to the orchestrator. Always finish by reporting.
