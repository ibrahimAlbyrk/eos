---
description: "MCP tool — dynamic_loop"
variables:
  - SPAWN_WORKER_TOOL
  - KILL_WORKER_TOOL
---

Attach a goal-driven loop to a worker (or to yourself) so the agent cannot finish until a structured goal is met. A looped worker that reports back before its goal passes is automatically re-triggered to keep working; it only truly completes once every criterion is satisfied. By default a loop is UNBOUNDED — its only stop conditions are goal-met and a no-progress safety net (the worker stops changing anything or starts cycling). Set `limit` to ALSO cap the number of attempts. Use this when "done" has a concrete, checkable definition and you want the work held to it without babysitting.

`op: "attach"` arms a loop. Provide:
- `goal.summary` — the one-line definition of done.
- `goal.criteria` — one or more independently checkable conditions, each `{ id, text, verify? }`. `verify` is an optional deterministic shell command that proves the criterion (used by the `command`/`hybrid` strategies).
- `target` — the worker id to loop. Omit (or pass your own id) to loop yourself.
- `strategy` (optional) — `command` (run each criterion's `verify`), `judge` (an LLM judges the goal), or `hybrid` (both). Defaults to `hybrid`.
- `limit` (optional) — the maximum number of re-trigger attempts before an UNMET loop gives up (exhausts). OMIT it for the default: UNBOUNDED — the loop runs until the goal is met or the no-progress detector stops it. Pass a number to cap attempts (or `null` to force unbounded explicitly). A goal met on the final allowed attempt still SUCCEEDS — the limit only bounds a loop that is NOT meeting its goal.

**Designing criteria — prefer command over judge.** Every criterion a shell command can prove (exit 0) should carry a `verify` and run under `command` or `hybrid`. A command verdict is deterministic — no LLM in the gate, nothing to parse, and un-game-able (a green command, not the worker's word, is what blocks reward-hacking). Reserve `judge`/`hybrid` for criteria a command genuinely cannot prove (a game "is playable," prose "reads well").

**Keep judged criteria evidence-LIGHT.** The judge grades over the change diff, the collected files, and the worker's report (truncated). A huge diff or an exotic-unicode artifact can make the judge's OWN output unparseable — which fail-closes to UNMET and re-triggers the worker, thrashing the loop to its limit over work that was actually fine. Scope each judged criterion narrowly; don't hand the judge one giant blob to grade.

**A judged criterion must be provable from what the gate collects.** The only evidence a criterion can be graded on is: its `verify` command output, the change diff, and the contents of files the criterion names by path. A criterion about runtime behavior ("the game is playable", "the server boots") names none of those and can therefore never be confirmed — give it a runnable smoke command as its `verify` (a headless boot that asserts frame 1 renders, a curl that asserts a 200), or expect the loop to escalate rather than pass. If the only possible check is a human's judgment, it is not a loop goal.

**Verify commands run in the worker's working directory.** They execute from the worker's checkout, not the repo root — reference files with absolute paths or `cd` into the right directory first, or the command fails to find what it is checking.

**Set an explicit `limit` for `judge`/`hybrid` goals.** A judged criterion the evidence can't confirm will otherwise re-trigger the worker until the no-progress net trips — a cap turns that into a clean, bounded exhaust the orchestrator can act on.

**An exhausted loop means the gate couldn't CONFIRM the goal — not that the work is wrong.** A loop ends UNMET only two ways: the attempt limit is hit, or the no-progress detector trips (the worker stopped changing anything, or is cycling). When that happens the worker's final report reaches you WRAPPED as "treat it as UNVERIFIED, the goal was never confirmed met." That wrapper describes the gate, not the work: a judge that returned "unparseable" counts as UNMET, so a correct result behind a too-big artifact or a vague judged criterion exhausts the same way genuinely-incomplete work does. On an exhausted-release report: read the worker's actual report and the `Still unmet:` list, and verify the load-bearing claim yourself — re-run the criterion's command before discarding the work. Exhausted ≠ failed.

`op: "amend"` renegotiates an ACTIVE loop's goal in place, keeping the worker and its work. Identify the loop with `loopId` (or `target`), then pass any of `goal`, `strategy`, `limit` you want to change — a provided field replaces the current value wholesale, an omitted field keeps it. Amend when a loop is stalling on a criterion the gate cannot see: add a `verify` command to that criterion, narrow (or drop) the criterion, or cap `limit` to turn an unbounded grind into a bounded exhaust you can act on. Amending the `goal` resets the no-progress history — the old attempt fingerprints reference criteria that may no longer exist — so the loop gets a fresh window. Amend is the surgical fix; `stop` remains the wholesale kill.

`op: "stop"` ends a loop you own — pass `loopId`, or `target` to stop that worker's active loop. Stopping releases the worker from the goal gate. To end a loop but KEEP the worker and its work, use `stop` — not {{KILL_WORKER_TOOL}}, which also destroys the worktree. Stop is the right move when a loop is thrashing (e.g. a judge that won't confirm correct work) but the partial work is worth keeping.

Constraints: only one active loop per target (attach refuses a second). You may only loop yourself or a worker you directly spawned.

Returns `{ loopId, status }` — on `attach`, `status: "active"` and `loopId` identifies the loop (keep it to `stop` that specific loop later); on `stop`, the loop's resulting status (`stopped`, or its terminal status if it had already ended).

When NOT to use: for open-ended exploration with no checkable finish line, or for a one-shot task that doesn't need to be re-driven — a plain worker directive is enough. A loop is for "keep going until X is provably true," not "do this once." Loop only when "done" has a finish line you can check WITHOUT taking the worker's word — ideally a shell command. If the only possible check is "a human reads it and decides" (a research synthesis, a design doc), that is a judged artifact, not a loop goal — don't loop it (§Swarm: don't loop the research or design phases). Also NOT to loop a worker you are about to spawn — arm `loop` inside {{SPAWN_WORKER_TOOL}} instead; attaching after spawn races the worker's first report and can let it pass UNGATED before the loop exists. Reserve `attach` for an already-running worker (or for looping yourself — omit `target`).
