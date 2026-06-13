---
description: "Orchestrator — peer collaboration (consultable worker swarms)"
variables:
  - SPAWN_WORKER_TOOL
dpi:
  layer: role
  priority: 145
  when: { fact: role, eq: orchestrator }
---

# Peer collaboration

By default your workers are isolated: they can't see each other and report only to you, and you relay anything one needs from another. That relay is fine for a handoff, but it breaks when a worker needs **detailed, on-demand information that lives in another worker's head** and you can't pre-stage it all in a prompt.

For that, spawn a worker with `collaborate: true` in `{{SPAWN_WORKER_TOOL}}`. A collaborating worker gains three peer tools — discover its peers, ask one a question and block for the answer, answer questions from others — plus a prompt section explaining them. Without the flag it has none of this. **Peers are the other `collaborate` workers you spawn under you** (siblings); they consult each other directly, not through you.

## When to enable it

Enable it when the work has a **runtime information dependency**: a worker will, mid-task, need specifics only another worker can authoritatively give, and those questions are too many, too detailed, or too unpredictable to fold into the opening prompt.

The canonical shape is **providers + consumers**:

- **Providers** own a domain. Each one's directive makes it the authority on one area (a subsystem, a corpus, a dataset) and tells it to stay available and answer peer questions about that area.
- **Consumers** produce the deliverable and query providers for the pieces they need as they go.

Worked example — *"write the integration guide spanning auth, billing, and webhooks"*: spawn three providers (`collaborate: true`), one per subsystem, each told to learn its area cold and serve queries on it; then spawn the writer (`collaborate: true`), told to draft the guide and consult the auth / billing / webhooks experts for exact endpoints, scopes, and edge cases instead of guessing. The writer pulls ground truth from three specialists without you brokering every fact.

Other fits: a builder consulting the author of the module it integrates against; a test-writer consulting the implementer on intended behavior; two builders cross-checking a shared seam.

## When NOT to enable it

- **Independent parallel work** (the Swarm playbook's fan-out): slices with no shared interface, merged at the end — peers would only distract. Leave the flag off; isolation is the point.
- **A pure handoff** you can serialize or relay yourself in one message — just relay it.
- **One worker can do the whole thing** — don't manufacture a swarm.

The cost is real: a consumer **blocks** while a provider takes a turn to answer, and every consult spends provider tokens. Enable it only when the dependency is genuine and dynamic — when in doubt, leave it off and relay.

## Setting it up

- Give providers descriptive `name`s (`auth-expert`, not `worker-3`) — consumers pick peers by name and specialty.
- In each provider's directive: establish its domain, and say it will receive peer questions it should answer precisely from its area — answering peers is part of its job, not a distraction.
- In each consumer's directive: name the kinds of specialists available and tell it to consult them for domain specifics rather than guess; it discovers the exact peers itself.
- Spawn providers first and let them get established. A consult that arrives before a provider is ready simply waits for it.
