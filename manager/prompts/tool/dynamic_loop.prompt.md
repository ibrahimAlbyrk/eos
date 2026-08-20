---
description: "MCP tool — dynamic_loop"
variables:
  - SPAWN_WORKER_TOOL
  - KILL_WORKER_TOOL
---

Attach a goal gate to a worker (or yourself): the agent cannot finish until a structured
goal verifies. A looped worker that reports early is re-triggered automatically; it
completes only when every criterion passes. Default is UNBOUNDED — the only exits are
goal-met and the no-progress detector; set `limit` to also cap attempts (a goal met on
the final allowed attempt still succeeds).

Ops:
- `attach` — arm a loop. `goal.summary` (one-line definition of done), `goal.criteria[]`
  (each `{ id, text, verify? }`, independently checkable), `target` (worker id; omit to
  loop yourself), `strategy` (`command` / `judge` / `hybrid`, default hybrid), `limit`.
- `amend` — renegotiate an ACTIVE loop in place (by `loopId` or `target`); a provided
  field replaces the current value wholesale, an omitted one keeps it. Use when a loop
  stalls on a criterion the gate cannot see: add a `verify`, narrow or drop the
  criterion, or cap `limit`. Amending the goal resets the no-progress history.
- `stop` — release the gate, keeping the worker and its work. To end a loop use `stop`,
  not {{KILL_WORKER_TOOL}} — kill also destroys the worktree.

Designing criteria:
- Prefer `command` over `judge`: any criterion a shell command can prove (exit 0) should
  carry a `verify` — deterministic, nothing to parse, un-game-able. Reserve judging for
  what a command genuinely cannot prove.
- A judged criterion is graded ONLY on its `verify` output, the change diff, and files
  the criterion names by path. Runtime-behavior criteria ("the server boots") name none
  of those and can never confirm — give them a smoke command as `verify`, or expect
  escalation instead of a pass. If the only possible check is a human's judgment, it is
  not a loop goal.
- Keep judged evidence LIGHT: a huge diff or exotic artifact can make the judge's own
  output unparseable, which fail-closes to UNMET and thrashes the loop over work that was
  fine. Scope judged criteria narrowly.
- Set an explicit `limit` on `judge`/`hybrid` goals so an unconfirmable criterion
  exhausts cleanly instead of grinding into the no-progress net.
- `verify` commands run in the worker's working directory, not the repo root — use
  absolute paths or `cd` first.

An exhausted loop means the gate could not CONFIRM the goal — not that the work is
wrong. The worker's final report reaches you wrapped as UNVERIFIED; read it and the
`Still unmet:` list, and re-run the criterion's command yourself before discarding the
work.

Constraints: one active loop per target; you may only loop yourself or a worker you
directly spawned. Returns `{ loopId, status }`.

When NOT to use: open-ended exploration or a one-shot task with no checkable finish
line — loop only when "done" is provable WITHOUT taking the worker's word, ideally by
shell command; a human-judged artifact (research synthesis, design doc) is not a loop
goal. And never to loop a worker you are about to spawn — arm `loop` inside
{{SPAWN_WORKER_TOOL}} instead: attaching after spawn races the worker's first report,
which can pass ungated.
