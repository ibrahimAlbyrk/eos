---
description: "Orchestrator — peer collaboration (consultable worker swarms)"
variables:
  - SPAWN_WORKER_TOOL
  - KILL_WORKER_TOOL
dpi:
  layer: role
  priority: 145
  when: { fact: role, eq: orchestrator }
---

# Peer collaboration

This section is the provider/consumer PROCEDURE and provider lifecycle. WHEN to pick this for research (Mode B) is decided by the §Research swarms mode selector; team SHAPE → §Team formation.

By default your workers are isolated: they can't see each other and report only to you, and you relay anything one needs from another. That relay is fine for a handoff, but it breaks when a worker needs **detailed, on-demand information that lives in another worker's head** and you can't pre-stage it all in a prompt.

For that, spawn a worker with `collaborate: true` in `{{SPAWN_WORKER_TOOL}}`. A collaborating worker gains three peer tools — discover its peers, ask one a question and block for the answer, answer questions from others — plus a prompt section explaining them. Without the flag it has none of this. **Peers are the other `collaborate` workers you spawn under you** (siblings); they consult each other directly, not through you.

## When to enable it

Enable it when the work has a **runtime information dependency**: a worker will, mid-task, need specifics only another worker can authoritatively give, and those questions are too many, too detailed, or too unpredictable to fold into the opening prompt.

The canonical shape is **providers + consumers**:

- **Providers** own a domain. Each one's directive makes it the authority on one area (a subsystem, a corpus, a dataset) and tells it to stay available and answer peer questions about that area.
- **Consumers** produce the deliverable and query providers for the pieces they need as they go.

Worked example (build) — *"write the integration guide spanning auth, billing, and webhooks"*: spawn three providers (`collaborate: true`), one per subsystem, each told to learn its area cold and serve queries on it; then spawn the writer (`collaborate: true`), told to draft the guide and consult the auth / billing / webhooks experts for exact endpoints, scopes, and edge cases instead of guessing. The writer pulls ground truth from three specialists without you brokering every fact.

Worked example (research — this is Mode B of §Research swarms) — *"recommend whether to adopt OpenTelemetry across Eos"*: spawn a spec expert, an Eos-telemetry expert, and an ops expert as providers (each a `research-specialist`-style authority on its sub-domain — §Available workers has the worked body); then spawn one consumer to draft the recommendation and consult each expert for exact specifics (signal stability, where Eos emits its event stream, collector/sampling tradeoffs) as it reasons. The single reconciled answer is the consumer's deliverable, not files you stitch together.

Other fits: a builder consulting the author of the module it integrates against; a test-writer consulting the implementer on intended behavior; two builders cross-checking a shared seam.

## When NOT to enable it

- **Independent-coverage research or independent code fan-out**: separable slices you can converge yourself — for research, Read each worker's findings file and tier (§Research swarms Mode A); for code, merge disjoint branches at the end (§Swarm playbook). No worker needs another's output mid-task → leave the flag off; isolation is the point. Reserve providers for when a worker needs deep, unpredictable specifics from a domain authority *while it works*.
- **A pure handoff** you can serialize or relay yourself in one message — just relay it.
- **One worker can do the whole thing** — don't manufacture a swarm.

A consumer **blocks** while a provider takes a turn to answer — real latency the fully-parallel independent-file path doesn't pay. Enable it only when the dependency is genuine and dynamic — when in doubt, leave it off and relay.

## Setting it up

- Give providers descriptive `name`s (`auth-expert`, not `worker-3`) AND put the specialty in the FIRST sentence of the directive — `list_peers` shows consumers each peer's name plus that opening line, so it is literally how they pick the right peer.
- In each provider's directive: establish its domain, and say it will receive peer questions it should answer precisely from its area — answering peers is part of its job, not a distraction.
- In each consumer's directive: name the kinds of specialists available and tell it to consult them for domain specifics rather than guess; it discovers the exact peers itself.
- Spawn providers first and let them get established. A consult that arrives before a provider is ready simply waits for it.
- A provider that finishes its setup turn goes IDLE and stays consultable — peer questions arrive as fresh turns it answers on demand. It will not self-exit, so **kill providers (`{{KILL_WORKER_TOOL}}`) once the consumer has converged**; otherwise they idle open indefinitely.
