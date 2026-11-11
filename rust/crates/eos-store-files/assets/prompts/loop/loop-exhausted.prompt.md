---
description: Synthesized report sent to the orchestrator when a looped worker's loop ended unmet and left no held report
variables:
  - REASON
  - ATTEMPTS
  - UNMET
---
✗ Dynamic loop ended without meeting the goal ({{REASON}}) after {{ATTEMPTS}} attempt(s).

Last unmet:
{{UNMET}}
