---
description: "MCP tool — workflow"
variables:
  - SPAWN_WORKER_TOOL
  - LB
  - RB
---

Author and launch a run on Eos's STANDALONE node-graph engine — a deterministic runtime
that executes a graph of typed nodes (fan-out/fan-in, pipelines, conditionals,
data-driven loops) with NO LLM driving the control flow, crash-safe resume included. Use
it instead of hand-orchestrating with {{SPAWN_WORKER_TOOL}} when the topology is known up
front: the engine spawns each step worker, awaits its typed output, binds it into
downstream prompts, and tears the run down at the end. The tool returns as soon as the
run STARTS; poll `status` or watch the dashboard.

Modes:
- `run-stored` — run a catalogued definition: `from` (name), optional `args` (bound as
  {{LB}}args.*{{RB}} in step prompts). Returns `{ runId, status: "running" }`.
- `run-inline` — run a one-off `spec` without persisting it: `{ name, root }`, where
  `root` is a node tree (`step` / `sequence` / `parallel` / `pipeline` / `forEach` /
  `conditional` / `loopUntil` / `phase` / `subWorkflow`). A `step` names a worker
  (`from`) + `prompt` and emits ONE typed output; with an `outputSchema` declared,
  downstream nodes bind it via {{LB}}nodes.<id>.output{{RB}}. Same return.
- `create` — validate and persist a `spec` for reuse (owner-scoped, upsert by name);
  defining does NOT start anything. Returns `{ name }`.
- `status` — read a run: `{ runId, status, output? }` (`running` / `passed` / `failed` /
  `stopped`).
- `stop` — abort by `runId`: halts further spawning and reaps the run's whole worker
  subtree. Returns `{ runId, status }`.

Notes: a step worker is an isolated node — it does NOT spawn sub-workers or consult
peers, and must NOT arm its own dynamic loop (the graph IS the control loop; use a
`loopUntil` node or a step's `loop` field). Runs survive a daemon restart: a re-armed
run replays finished nodes from their journaled output and continues.
