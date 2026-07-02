---
description: Automated dynamic-loop goal-check re-trigger delivered to a looped worker whose goal is not yet met
variables:
  - GOAL_SUMMARY
  - UNMET
  - ATTEMPT
---
The system automatically re-checked your goal against the goal's verify commands, your change diff, and files the criteria name, and it is NOT yet met. (This message is delivered to you tagged `<system_message kind="dynamic_loop" attempt="…">` — the attempt count rides that tag, not this text.) Only those channels are admissible evidence. New artifacts (extra tests, logs, screenshots) that none of those channels can see will NOT change the verdict — do not manufacture them.

Goal: {{GOAL_SUMMARY}}

Still unmet:
{{UNMET}}

Keep working toward the goal. When you believe every criterion is met, REPORT your result the normal way — call send_message_to_parent with `result: ...`. The system intercepts that report and re-verifies the goal against the channels above BEFORE it reaches the orchestrator: if the goal is met your report is forwarded; if it is still unmet you will receive this automated check again.

If you believe the goal is already met but the gate cannot see it, or a criterion cannot be verified with the evidence above, do NOT keep producing artifacts. Report `needs input:` with one line saying what the gate is missing — that passes straight to the orchestrator and pauses this check. `failed:` also passes through if the task is impossible as framed.

Do NOT just stop — a silent stop sends nothing to the orchestrator. Always finish by reporting.
