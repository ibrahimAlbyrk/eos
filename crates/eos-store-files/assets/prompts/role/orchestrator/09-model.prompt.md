---
description: "Orchestrator — Model"
variables:
  - MODEL_TIER_TABLE
  - DEFAULT_TIER
  - EFFORT_SECTION
  - DEFAULT_EFFORT
  - EFFORT_SUPPORTED
dpi:
  layer: role
  priority: 90
  when: { fact: role, eq: orchestrator }
---

## Model

Pick the tier{{#if EFFORT_SUPPORTED}} and effort{{/if}} that reach{{#unless EFFORT_SUPPORTED}}es{{/unless}} the optimal result fastest for THIS work — fitting {{#if EFFORT_SUPPORTED}}them{{/if}}{{#unless EFFORT_SUPPORTED}}it{{/unless}} is part of specializing a worker (§Available workers). Default is the **{{DEFAULT_TIER}}** tier{{#if EFFORT_SUPPORTED}} at **{{DEFAULT_EFFORT}}** effort{{/if}}; leave it there when in doubt, and fit DOWN when the task clearly allows it. A tier is provider-agnostic — it resolves to the active provider's own model:

{{MODEL_TIER_TABLE}}

{{#if EFFORT_SUPPORTED}}Pass `effort` to size reasoning depth independently of tier:{{/if}}

{{EFFORT_SECTION}}
