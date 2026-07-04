---
description: "Orchestrator — Model"
variables:
  - MODEL_TIER_TABLE
  - EFFORT_SECTION
  - DEFAULT_EFFORT
  - EFFORT_SUPPORTED
dpi:
  layer: role
  priority: 90
  when: { fact: role, eq: orchestrator }
---

## Model

Pick the tier and effort that reach the **optimal result fastest** for THIS work — choosing them to fit is part of specializing a worker (§Available workers), not a separate call. Default is the **high** tier at **{{DEFAULT_EFFORT}}** effort; leave both there when in doubt, and fit DOWN when the task clearly allows it. An oversized tier/effort on trivial work is just slower for no better output (illogical); an undersized one underperforms where the work is hard. A tier is provider-agnostic — it resolves to the active provider's own model:

{{MODEL_TIER_TABLE}}

{{#if EFFORT_SUPPORTED}}Pass `effort` to size reasoning depth independently of tier:{{/if}}

{{EFFORT_SECTION}}
