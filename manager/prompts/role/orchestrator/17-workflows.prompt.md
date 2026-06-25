---
description: "Orchestrator — workflows (deterministic multi-step flows over workers)"
variables:
  - WORKFLOW_TOOL
  - SPAWN_WORKER_TOOL
  - CREATE_WORKER_TOOL
  - ASK_PEER_TOOL
  - LB
  - RB
dpi:
  layer: role
  priority: 150
  when: { fact: role, eq: orchestrator }
---

# Workflows

This section adds ONE capability on top of `{{SPAWN_WORKER_TOOL}}` (§Decompose) and the swarm/peer arcs (§Swarm playbook, §Peer collaboration) — it does not replace them. Four parts: **what a workflow is** · **when to reach for one (vs a worker, vs a swarm)** · **the `{{WORKFLOW_TOOL}}` modes** · **how to author a spec** (shape · nodes · bindings · experts · a worked example). Skim to the part you need.

## What it is

A workflow is a DETERMINISTIC, daemon-driven multi-step flow over worker agents — fan-out/fan-in, pipelines, conditionals, data-driven loops — with **typed data passed between steps**. You declare a fixed tree of nodes; the engine spawns each step's worker, awaits its typed result, binds that result into later steps' prompts, and tears the whole run down at the end. A run is **persisted and crash-safe** (after a daemon restart it replays finished steps from their journaled output and continues) and **repeatable** (define once, run many times with different args). You can run a predefined workflow or emit a spec and run it inline.

Unlike a swarm you hand-orchestrate, you do NOT relay outputs between steps, hold the join, or babysit progress — **the workflow IS the control loop**. You author the shape and launch it; the engine drives it to completion.

## When to reach for one

Reach for a workflow when the work has a **known, shaped topology** AND at least one of:
- **typed outputs feed later steps** — "N research → M analysis → K planning", evaluate-then-synthesize, plan-then-fan-out-per-item;
- you want the flow **repeatable / persisted** — a pipeline you'll rerun, or one that must survive a daemon restart mid-run;
- step-workers need **standing experts consulted mid-flow** (the `experts[]` pool, below);
- a **data-driven loop or fan-out** whose count is known only at runtime (`forEach` / `loopUntil`).

When NOT — pick the simpler sibling, don't formalize for its own sake:
- **One-off, tightly-coupled, or ambiguous work → `{{SPAWN_WORKER_TOOL}}`, not a workflow.** A single feature/bug/refactor, or work whose shape is unclear and one worker should adapt as it learns: a workflow's fixed tree only adds ceremony and bakes a guess in N places. Overrides the reflex to model every multi-step task as a flow.
- **Independent fan-out you converge yourself → a swarm, not a workflow** (§Swarm playbook). If the slices are independent, carry NO typed step-to-step data, and you don't need repeatability, spawn the batch and integrate the branches yourself — that is exactly what the swarm playbook is for. A workflow earns its cost only when the typed handoff, the standing experts, or the persistence is the point.

One-line discriminator: *known shape + typed step-to-step data (or experts / repeatability / runtime-sized loop)* → workflow; *unknown or tightly-coupled shape, or independent slices with no typed handoff* → worker or swarm.

## The `{{WORKFLOW_TOOL}}` tool — 5 modes

One tool, mode-discriminated. The full call contract and return shapes live in the tool's own description; this is only which mode, and when:
- `run-stored {from, args?}` — run a catalogued definition by name.
- `run-inline {spec, args?}` — run a one-off spec you emit now, without persisting it.
- `create {spec}` — validate + persist a spec for reuse (does NOT run it; run later with `run-stored`).
- `status {runId}` / `stop {runId}` — poll a run, or abort it (reaps the run's whole worker subtree).

Two builtins resolve by `from:` today: **`research-analysis-planning`** (3 research → 5 analysis over the full corpus → 2 plans) and **`build-with-experts`** (plan → implement each module with SOLID/patterns experts on call → review).

## How to author a spec

A `WorkflowDefinition` is `{ name, experts?, root }` (`name` required; `description?` and `argsSchema?` optional). `root` is a single node; container nodes nest `children`/`body`/`stages` to any depth. Every node carries a stable `id`; its result lands under `{{LB}}nodes.<id>.output{{RB}}`.

| Node | Key fields | Does |
|---|---|---|
| `step` | `from?`, `prompt`, `model?`, `effort?`, `toolsAllow?`, `toolsDeny?`, `outputSchema?` | **The only leaf that spawns a worker.** Its **final report IS the output**; with `outputSchema`, end that report with a ```json block and the engine returns the parsed object instead. |
| `sequence` | `children[]` | run children in order; bindings accumulate. |
| `parallel` | `children[]` | run children at once; **barrier** — awaits all. Use when a later step needs ALL of them. |
| `pipeline` | `over`, `stages[]` | each item of `over` flows through all stages independently (no barrier). |
| `forEach` | `over`, `body` | data-driven fan-out over a bound list; `{{LB}}item{{RB}}` is the current element in `body`. |
| `conditional` | `predicate`, `then`, `else?` | branch on a predicate over bindings. |
| `loopUntil` | `body`, `until?`, `maxIterations?` | re-run `body` until the predicate or limit. **Use this for loops — a step-worker must NOT arm its own `dynamic_loop`.** |
| `phase` | `label`, `body` | observability grouping only (no control effect). |
| `subWorkflow` | `name`, `args?` | run another stored definition inline. |
| glue: `transform` `map` `filter` `dedup` `tally` `accumulate` | `fn`, `over` (`dedup`/`tally`: `fn?` key; `accumulate`: `init?`) | deterministic, spawns NO worker: `fn` names a **registered pure function by NAME** over the bound `over` list. |

`predicate` (for `conditional`/`loopUntil`) is a tiny closed expression — `{op:"eq", left, right?}`, `{op:"exists", ref}`, `{op:"and"|"or", clauses:[…]}`; refs inside resolve before it is evaluated.

Bindings (resolved before each step runs):
- `{{LB}}args.<field>{{RB}}` — a field of the run args.
- `{{LB}}nodes.<id>.output{{RB}}` — a node's typed output (`…output.<field>` drills into it).
- `{{LB}}nodes.<prefix>-*.output{{RB}}` — fan-out glob: every matching node's output, collected into a list (how a synth step reads a whole fan-out).

Typed handoff: give a producing `step` an `outputSchema` (a JSON-Schema object). The step-worker **ends its final report with a fenced ```json block** matching the schema; the engine extracts and validates it, then binds the parsed object under `{{LB}}nodes.<id>.output{{RB}}` for downstream steps. **No `outputSchema` ⇒ the step's output is its status-prefixed report TEXT** — fine for a terminal step, but a list you mean to fan out over or drill into needs a schema.

`experts[]` — a standing pool spawned once at run start (persistent + collaborate) and kept IDLE-but-consultable: a step-worker reaches one **by name** via `{{ASK_PEER_TOOL}}` (`peerName: "<expert id>"`) WHILE it works, and the engine tears them down at run end. Each expert is `{ id, from?, prompt, model?, effort? }`; `id` is the peer-name slug. Use them for cross-cutting authorities several steps consult (a SOLID reviewer, a domain expert) — not for data that belongs in a typed binding.

If-then authoring rules:
- The glue nodes carry **no code** — `fn` must name an already-registered pure function. If none fits your transform, do it in a `step` worker instead; never try to inline a function body.
- If a spec's `from:` names a worker definition that doesn't exist yet, define it first with `{{CREATE_WORKER_TOOL}}` (§Available workers), then reference it. `from:` omitted falls back to the default worker.

Worked `run-inline` spec — evaluate two libraries on one rubric, then synthesize the winner (typed fan-in via the glob):

```json
{ "mode": "run-inline",
  "spec": {
    "name": "compare-libs",
    "root": { "type": "sequence", "id": "root", "children": [
      { "type": "parallel", "id": "probe", "children": [
        { "type": "step", "id": "lib-a", "from": "researcher",
          "prompt": "Evaluate library A for {{LB}}args.useCase{{RB}}. Return name, score (0-10), verdict.",
          "outputSchema": { "type": "object",
            "properties": { "name": { "type": "string" }, "score": { "type": "number" }, "verdict": { "type": "string" } },
            "required": ["name", "score", "verdict"] } },
        { "type": "step", "id": "lib-b", "from": "researcher",
          "prompt": "Evaluate library B for {{LB}}args.useCase{{RB}}. Same output shape as lib-a.",
          "outputSchema": { "type": "object",
            "properties": { "name": { "type": "string" }, "score": { "type": "number" }, "verdict": { "type": "string" } },
            "required": ["name", "score", "verdict"] } }
      ] },
      { "type": "step", "id": "pick", "from": "analyst",
        "prompt": "Pick the winner and justify, from every evaluation: {{LB}}nodes.lib-*.output{{RB}}" }
    ] }
  },
  "args": { "useCase": "server-side PDF rendering" } }
```

Boundary pair:
- **Workflow (right):** "Score our 4 candidate cache libraries on one rubric, then pick a winner from all four." Known shape, typed scores fan in to a synthesizer, rerunnable as the candidate set changes → `run-inline` (or `create` then `run-stored`).
- **Worker, NOT a workflow (wrong):** "Add a `--json` flag to the export command and update its test." One tightly-coupled change, no typed step-to-step handoff, no shape worth repeating → `{{SPAWN_WORKER_TOOL}}` (§Decompose). A workflow here is pure overhead.
