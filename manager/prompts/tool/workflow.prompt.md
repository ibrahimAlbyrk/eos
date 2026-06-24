---
description: "MCP tool — workflow"
variables:
  - SPAWN_WORKER_TOOL
  - LB
  - RB
---

Run a DETERMINISTIC, multi-step workflow — a fixed tree of worker steps the daemon drives for you (fan-out / fan-in, pipelines, conditionals, data-driven loops), with typed step-to-step data, crash-safe resume, and a standing expert pool the steps consult while they work. Use this instead of hand-orchestrating with {{SPAWN_WORKER_TOOL}} when the topology is known up front and you want it driven reliably to completion — the engine spawns each step, awaits its typed result, binds it into the next step's prompt, and tears the whole run down at the end. The tool returns as soon as the run STARTS; poll `status` (or watch the dashboard) for progress.

`mode: "run-stored"` — run a catalogued definition by name. Provide:
- `from` — the workflow definition name (built-in, on-disk `~/.eos/workflows/*`, or one you created).
- `args` (optional) — the run arguments object, bound as `{{LB}}args.*{{RB}}` in step prompts.
Returns `{ runId, status: "running" }`.

`mode: "run-inline"` — run a one-off definition without persisting it. Provide:
- `spec` — the full workflow definition object: `{ name, root, experts? }`, where `root` is a node tree (`step` / `sequence` / `parallel` / `pipeline` / `forEach` / `conditional` / `loopUntil` / `phase` / `subWorkflow`). A `step` names a worker (`from`) + `prompt` and, when it declares an `outputSchema`, returns a typed object downstream steps bind by `{{LB}}nodes.<id>.output{{RB}}`.
- `args` (optional) — as above.
Returns `{ runId, status: "running" }`.

`mode: "create"` — validate and persist a `spec` for reuse (owner-scoped, upsert by name). Defining does NOT start anything — run it later with `run-stored`. Returns `{ name }`.

`mode: "status"` — read a run by `runId`. Returns `{ runId, status, output? }` (status is `running` / `passed` / `failed` / `stopped`).

`mode: "stop"` — abort a run by `runId`: marks it `stopped`, halts further spawning, and reaps the run's whole worker subtree (experts + step-workers). Returns `{ runId, status }`.

Notes: a workflow step-worker must NOT arm its own dynamic loop — the workflow IS the control loop; use a `loopUntil` node instead. The standing experts (declared in the definition's `experts`) are spawned once at run start and kept consultable via the peer mesh, then torn down when the run ends. Runs survive a daemon restart: a re-armed run replays its already-finished steps from their journaled output and continues.
