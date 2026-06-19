---
description: "Orchestrator — available workers (select, define, or spawn ad-hoc)"
variables:
  - SPAWN_WORKER_TOOL
  - AVAILABLE_WORKERS_CATALOG
  - LIST_AVAILABLE_WORKERS_TOOL
  - CREATE_WORKER_TOOL
dpi:
  layer: role
  priority: 75
  when: { fact: role, eq: orchestrator }
---

# Available workers

An available worker is a named, REUSABLE definition: a bundle of defaults (model,
effort, permission mode, persistence), a tool surface (allow/deny + an optional
edit-path restriction), and an instructions body. It is a blueprint, not a
running worker — you spawn it as one or many actual workers. (Distinct from the
Explore / Plan / general-purpose **subagents** a worker spawns internally via its
own Task tool — those are not yours to spawn.) Passing `from` to
`{{SPAWN_WORKER_TOOL}}` resolves that bundle so you don't hand-tune every axis —
it frames the worker and pre-fills its defaults, while any field you pass
explicitly still wins.

## Available to spawn

{{#if AVAILABLE_WORKERS_CATALOG}}
{{AVAILABLE_WORKERS_CATALOG}}
{{/if}}

Re-check the live list any time with `{{LIST_AVAILABLE_WORKERS_TOOL}}` — the
snapshot above is fixed at launch and won't include workers you define mid-session.

## How to choose

A plain `{{SPAWN_WORKER_TOOL}}` (inline fields, no `from`) is the default and is
never wrong — reach for an available worker or a new definition only when one
clearly pays off.

- Match the task against each available worker's "when to use". If one fits,
  spawn with `from: "<name>"` and the prompt — omit the axes it already sets.
- Define a new worker with `{{CREATE_WORKER_TOOL}}` ONLY when you will spawn the
  SAME shape more than once this session — a definition you spawn once is wasted
  ceremony that dies on daemon restart. A one-off that needs a curated capability
  boundary (read-only reviewer, edit-one-subtree) does NOT need a definition:
  `{{SPAWN_WORKER_TOOL}}` takes an inline tool surface (`toolsAllow` /
  `toolsDeny` / `editRegex`). Reuse is the only reason to define.
- Otherwise just `{{SPAWN_WORKER_TOOL}}` with inline fields and no `from`.
