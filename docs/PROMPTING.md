# How the orchestrator prompts its workers

> The craft behind Eos's fan-out. This is *encoded*, not improvised — it lives in the prompt library at `manager/prompts/role/orchestrator/`, assembled per-spawn by DPI (deterministic prompt injection).

A sub-agent is only as good as its brief. Most multi-agent systems split a task and hope. Eos's orchestrator writes each worker's prompt the way a senior engineer writes a handoff.

## Every worker prompt has the same shape

The outcome first, then only the facts the worker can't cheaply discover for itself:

```
<directive — ONE outcome sentence: the result and where it lands>

Context:      environment map — paths, the pattern to match, an invariant no grep surfaces
Acceptance:   a check the worker can run or observe — plus what to do when it can't be met
Out of scope: a fence, only when wander-risk exists — each ban paired with a do-instead
Report:       the task-specific delta — the standard report wrapper is automatic
```

## It's taught by contrast

*"improve the message queue"* becomes *"add `DELETE /workers/:id/queue` that clears all undispatched messages for one worker."* *"make it work"* becomes *"`npm test` passes; endpoint returns `{removed:n}`; can't pattern-match a bulk delete → report `needs input:`."*

Conditional add-ons fire only when their trigger does:

- **Read-first** — when the task hinges on an existing pattern.
- **Honor** — when a non-obvious prior decision binds the design.
- **Known-failure-mode** — when a similar task failed a specific way before.

## Acceptance always defines its own failure

A worker that can't clear the bar is told to report `needs input:` or `failed:` — never to fake a pass. Workers answer on a three-token protocol the orchestrator parses by the first line — `result:` / `needs input:` / `failed:`. Every worktree branch is handed back on a machine-parsed `Handover:` line whose verdict (`passed` only after the command actually ran) is held to honesty.

## Fan-out is disciplined, not eager

The default is one worker; a wrong split bakes a bad assumption in N times. When the parts are genuinely independent, the swarm playbook runs a hard gate first:

1. **Settle the contract** — APIs, data shapes, file ownership — before any parallel work. Isolated worktrees each invent their own interface otherwise.
2. **Fan out in rounds with disjoint ownership** so the branches merge clean.
3. **Integrate and verify** the combined result.
4. **Independently re-check load-bearing claims** — "re-run the command, confirm or refute, don't edit."

For investigations the same arc becomes a research swarm: 4–8 overlapping dimensions, evidence written to files, findings tiered by cross-confirmation.

## Workers can also consult each other

A `collaborate` swarm pairs **providers** — each the authority on one subsystem — with **consumers** that pull ground truth on demand instead of guessing. No fact routed back through the orchestrator.
