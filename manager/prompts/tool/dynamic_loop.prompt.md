---
description: "MCP tool — dynamic_loop"
---

Attach a goal-driven loop to a worker (or to yourself) so the agent cannot finish until a structured goal is met. A looped worker that reports back before its goal passes is automatically re-triggered to keep working; it only truly completes once every criterion is satisfied. By default a loop is UNBOUNDED — its only stop conditions are goal-met and a no-progress safety net (the worker stops changing anything or starts cycling). Set `limit` to ALSO cap the number of attempts. Use this when "done" has a concrete, checkable definition and you want the work held to it without babysitting.

`op: "attach"` arms a loop. Provide:
- `goal.summary` — the one-line definition of done.
- `goal.criteria` — one or more independently checkable conditions, each `{ id, text, verify? }`. `verify` is an optional deterministic shell command that proves the criterion (used by the `command`/`hybrid` strategies).
- `target` — the worker id to loop. Omit (or pass your own id) to loop yourself.
- `strategy` (optional) — `command` (run each criterion's `verify`), `judge` (an LLM judges the goal), or `hybrid` (both). Defaults to `hybrid`.
- `limit` (optional) — the maximum number of re-trigger attempts before an UNMET loop gives up (exhausts). OMIT it for the default: UNBOUNDED — the loop runs until the goal is met or the no-progress detector stops it. Pass a number to cap attempts (or `null` to force unbounded explicitly). A goal met on the final allowed attempt still SUCCEEDS — the limit only bounds a loop that is NOT meeting its goal.

`op: "stop"` ends a loop you own — pass `loopId`, or `target` to stop that worker's active loop. Stopping releases the worker from the goal gate.

Constraints: only one active loop per target (attach refuses a second). You may only loop yourself or a worker you directly spawned.

When NOT to use: for open-ended exploration with no checkable finish line, or for a one-shot task that doesn't need to be re-driven — a plain worker directive is enough. A loop is for "keep going until X is provably true," not "do this once."
