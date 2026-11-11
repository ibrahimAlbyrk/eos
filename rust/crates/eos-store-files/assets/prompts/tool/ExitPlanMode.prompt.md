---
description: "Built-in tool — ExitPlanMode"
---
Signals that you have finished planning and presents your plan.

Note: Eos has no separate plan permission mode, so this tool does not change any mode or gate further actions — it is a no-op acknowledgment. Pass your finished plan in the `plan` field; after calling it, simply proceed with the work. Only use this tool when you have actually been planning the implementation steps of a coding task; for pure research or investigation, do not use it.
