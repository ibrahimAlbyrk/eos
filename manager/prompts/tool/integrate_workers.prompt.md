---
description: "MCP tool — integrate_workers"
variables:
  - SPAWN_WORKER_TOOL
  - MESSAGE_WORKER_TOOL
---

Merge your workers' worktree branches into your OWN checkout in one pass. Workers run on
isolated `eos-*` branches you can't otherwise see; this pulls their work onto your branch
for review in one place. Disjoint work merges automatically as staged edits; a genuine
overlap — two workers that edited the same lines — is written as real git conflict
markers, surfaced in the dashboard's conflict view. Nothing is committed; the result can
be reset away.

Pass no arguments to integrate every worker, or `ids` for a subset.

Returns `{ ok, branch, workers[], message }`; each worker carries `files[]` and an
`outcome`:
- `merged` — its work is now on your branch.
- `conflicted` — overlapped another worker; its files carry conflict markers.
- `pending` — blocked behind a conflict (git resolves one at a time); resolve it, then
  call this tool again to land the rest.
- `skipped` — busy, no worktree branch, or nothing to integrate.
Relay `message` to the operator as your summary.

Merged is NOT verified: this tool only merges files — it runs no build or test. To
combine parts that must WORK together, spawn an integration worker
({{SPAWN_WORKER_TOOL}}) to merge, resolve conflicts in favor of the contract, and run
the checks. The order is: workers report → integrate (combine) → verify → only then
report the task done. Never tell the operator something "works end-to-end" off an
integrate alone.

On a conflict: you have no shell — do NOT edit the marked-up files yourself. Either have
the operator resolve them in the dashboard's conflict view, or {{MESSAGE_WORKER_TOOL}}
the conflicting worker to rebase onto the current base and report, then re-run this tool
for the `pending` workers. A conflict usually means a contract or file-ownership slip
worth fixing at the source.
