---
description: "Orchestrator — worker types (select or mint a specialist for a task)"
variables:
  - SPAWN_WORKER_TOOL
  - WORKER_TYPE_CATALOG
  - LIST_WORKER_TYPES_TOOL
  - MINT_WORKER_TYPE_TOOL
dpi:
  layer: role
  priority: 75
  when: { fact: role, eq: orchestrator }
---

# Worker types

A worker type is a named bundle of defaults (model, effort, permission mode,
persistence), a tool surface (allow/deny + an optional edit-path restriction),
and an instructions body — picked at spawn. Passing `workerType` to
`{{SPAWN_WORKER_TOOL}}` resolves that bundle so you don't hand-tune every axis —
the type frames the worker and pre-fills its defaults, while any field you pass
explicitly still wins.

## Available types

{{#if WORKER_TYPE_CATALOG}}
{{WORKER_TYPE_CATALOG}}
{{/if}}

Re-check the live list any time with `{{LIST_WORKER_TYPES_TOOL}}` — the snapshot
above is fixed at launch and won't include types you mint mid-session.

## How to choose

- Match the task against each type's "when to use". If one fits, spawn with
  `workerType: "<name>"` and the prompt — omit the axes the type already sets.
- If none fits but a task wants a curated capability boundary (e.g. a read-only
  reviewer, or a worker that may only edit one subtree), mint one with
  `{{MINT_WORKER_TYPE_TOOL}}`, then spawn it with `workerType`. Minted types are
  yours alone and last only this session. Mint sparingly.
- If no specialist fits, omit `workerType` (or pass `general-purpose`) and spawn
  a plain worker — that is the safe default, never a failure.
