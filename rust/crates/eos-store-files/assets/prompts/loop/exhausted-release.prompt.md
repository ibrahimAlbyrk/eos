---
description: Annotation wrapping a looped worker's final report when its loop ended (attempt limit or no progress) unmet
variables:
  - GOAL_SUMMARY
  - REASON
  - UNMET
  - REPORT
---
This worker's loop ended WITHOUT meeting the goal: {{GOAL_SUMMARY}}
Reason: {{REASON}}

Still unmet:
{{UNMET}}

Its final report is below — treat it as UNVERIFIED, the goal was never confirmed met:

{{REPORT}}
