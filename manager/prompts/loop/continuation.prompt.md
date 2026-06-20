---
description: Automated dynamic-loop goal-check re-trigger delivered to a looped worker whose goal is not yet met
variables:
  - GOAL_SUMMARY
  - UNMET
  - ATTEMPT
---
[DYNAMIC LOOP — AUTOMATED GOAL-CHECK · attempt {{ATTEMPT}}] This is NOT a message from a human or the orchestrator. The system automatically re-checked your goal against the actual artifacts (tests, diff, files) and it is NOT yet met.

Goal: {{GOAL_SUMMARY}}

Still unmet:
{{UNMET}}

Keep working toward the goal. When you believe every criterion is met, REPORT your result the normal way — call send_message_to_parent with `result: ...`. The system intercepts that report and re-verifies the goal against the artifacts BEFORE it reaches the orchestrator: if the goal is met your report is forwarded; if it is still unmet you will receive this automated check again. Do NOT just stop — a silent stop sends nothing to the orchestrator. Always finish by reporting.
