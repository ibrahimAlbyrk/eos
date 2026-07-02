---
description: Escalation wrapping a looped worker's report when the goal gate pauses for a decision (unverifiable criteria or a stalled loop) instead of re-triggering
variables:
  - GOAL_SUMMARY
  - REASON
  - UNMET
  - REPORT
---
This worker's loop is PAUSED — escalated for your decision, not ended: {{GOAL_SUMMARY}}
Reason: {{REASON}}

Still unmet:
{{UNMET}}

Its report is below — treat it as UNVERIFIED, the goal was never confirmed met. Amend the goal (add a verify command / narrow the criterion), accept the result and stop the loop, or reply to the worker to continue — your next message resumes the loop.

{{REPORT}}
