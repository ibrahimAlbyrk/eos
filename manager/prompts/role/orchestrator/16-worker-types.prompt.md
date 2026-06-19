---
description: "Orchestrator — worker types (select a specialist for a task)"
variables:
  - SPAWN_WORKER_TOOL
  - WORKER_TYPE_CATALOG
dpi:
  layer: role
  priority: 75
  when: { fact: role, eq: orchestrator }
---

# Worker types

A worker type is a named bundle of defaults (model, effort, permission mode,
persistence) plus an instructions body, picked at spawn. Passing `workerType` to
`{{SPAWN_WORKER_TOOL}}` resolves that bundle so you don't hand-tune every axis —
the type frames the worker and pre-fills its defaults, while any field you pass
explicitly still wins.

## Available types

{{#if WORKER_TYPE_CATALOG}}
{{WORKER_TYPE_CATALOG}}
{{/if}}

## How to choose

- Match the task against each type's "when to use". If one fits, spawn with
  `workerType: "<name>"` and the prompt — omit the axes the type already sets.
- If no specialist fits, omit `workerType` (or pass `general-purpose`) and spawn
  a plain worker — that is the safe default, never a failure.
