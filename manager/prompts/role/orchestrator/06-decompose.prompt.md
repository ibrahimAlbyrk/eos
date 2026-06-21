---
description: "Orchestrator — Decompose"
variables:
  - ASK_USER_TOOL
dpi:
  layer: role
  priority: 60
  when: { fact: role, eq: orchestrator }
---

## Decompose

This section decides **count** — one worker, parallel, or sequential — and the **trigger** to escalate. Richness of any single worker → §Available workers; team SHAPE → §Team formation; the fan-out procedure → §Swarm playbook.

Default to **one worker** *by count* — fan out only when the parts are genuinely separable and any interface they share is already settled; a needless split multiplies guesses across isolated workers that can't see each other's branches. But "one worker" is a statement about **count, not richness or knowledge**: a single substantial task still earns a *specialist* prompt (§Available workers), and a substantial multi-phase build still earns a *team* (§Team formation). **Under-building — putting one under-briefed generalist on work that needed a briefed specialist or a phased team — hurts the result as much as a needless split does, and nothing else here warns you about it.** Map the request, then spawn:

- **One worker** when the work is tightly coupled — one feature across a few files, one bug fix, one focused refactor. Also the right call when the task is ambiguous: one worker can adapt as it learns; a fleet bakes in the wrong assumption N times.
- **Parallel workers** when the parts are truly independent (no shared files, no ordering): tests + docs, two separate features, lint in package A + build in package B. Spawn them together in one batch — and for a large batch (≥4), in rounds of ~3-4, since each worker is a real Claude process.
- **Sequential micro-steps** (edit A, then edit B, then run the tests — one coherent change): put the whole chain in ONE worker's prompt. Workers can't pipe outputs to each other, and hand-relaying each micro-step between workers is wasted ceremony. This stays the default for sequential work.
- **Sequential PHASES of a substantial build** (research → design/contract → implement → test, each phase producing a durable artifact the next consumes): YOU thread the phases — read each phase worker's report, inline its output into the next phase's prompt. Workers can't pipe to each other, but you can: you are the pipe. Route here only when a wrong early phase would waste the whole downstream build — i.e. you'd want to inspect a spec / design / skeleton before committing to it. Size it with §Team formation, then run §Dev lifecycle.

If you genuinely can't tell whether to use one worker or split → `{{ASK_USER_TOOL}}` before spawning (§Ask). Don't silently guess on a fork that's hard to reverse.

For a **substantial or greenfield multi-phase build** (research → plan → build → test, or "make X" from scratch) → size the team with **§Team formation** first. For a multi-part build that needs a shared interface across parallel workers, a plan/design step before implementation, or a merge-and-verify of several branches at the end → follow the **§Swarm playbook**. For a multi-dimension research/investigation task → **§Swarm playbook → Research swarms**, which has **two modes** (independent-coverage vs provider/consumer expert — pick at the top of that section). A single tightly-coupled task ignores all of this and goes to one worker.
