---
description: "MCP tool — workflow"
variables:
  - SPAWN_WORKER_TOOL
  - LB
  - RB
---

Author and launch a run on Eos's STANDALONE node-graph engine — a deterministic runtime that executes a graph of typed nodes (fan-out / fan-in, pipelines, conditionals, data-driven loops) input→output with NO LLM driving the control flow, crash-safe resume included. The engine also runs zero-LLM from a graph file, the `eos workflow` CLI, or the node-editor UI; this tool is the ONE optional path for an orchestrator to drive it. Through it you author a node tree the engine compiles into that graph and runs to completion. Use it instead of hand-orchestrating with {{SPAWN_WORKER_TOOL}} when the topology is known up front and you want it driven reliably — the engine spawns each step worker, awaits its typed output, binds it into downstream prompts, and tears the whole run down at the end. The tool returns as soon as the run STARTS; poll `status` (or watch the dashboard) for progress.

`mode: "run-stored"` — run a catalogued definition by name. Provide:
- `from` — the workflow definition name (built-in, on-disk `~/.eos/workflows/*`, or one you created).
- `args` (optional) — the run arguments object, bound as `{{LB}}args.*{{RB}}` in step prompts.
Returns `{ runId, status: "running" }`.

`mode: "run-inline"` — run a one-off definition without persisting it. Provide:
- `spec` — the workflow definition object: `{ name, root }`, where `root` is a node tree (`step` / `sequence` / `parallel` / `pipeline` / `forEach` / `conditional` / `loopUntil` / `phase` / `subWorkflow`) the engine compiles into its graph. A `step` names a worker (`from`) + `prompt`; the worker does the node's work in isolation and emits ONE typed output, and when the node declares an `outputSchema` that output is a typed object downstream nodes bind by `{{LB}}nodes.<id>.output{{RB}}`.
- `args` (optional) — as above.
Returns `{ runId, status: "running" }`.

`mode: "create"` — validate and persist a `spec` for reuse (owner-scoped, upsert by name). Defining does NOT start anything — run it later with `run-stored`. Returns `{ name }`.

`mode: "status"` — read a run by `runId`. Returns `{ runId, status, output? }` (status is `running` / `passed` / `failed` / `stopped`).

`mode: "stop"` — abort a run by `runId`: marks it `stopped`, halts further spawning, and reaps the run's whole worker subtree (experts + step-workers). Returns `{ runId, status }`.

Notes: a step worker runs as an isolated node — it does NOT spawn sub-workers or consult peers, and must NOT arm its own dynamic loop (the graph IS the control loop; use a `loopUntil` node, or a `step`'s `loop` field, instead). Runs survive a daemon restart: a re-armed run replays its already-finished nodes from their journaled output and continues.
