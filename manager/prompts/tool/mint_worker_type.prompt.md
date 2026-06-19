---
description: "Tool description — mint_worker_type"
---

Define a NEW worker type when no existing type's `whenToUse` fits a task. You supply its defaults (model, effort, permission mode, persistence), its tool surface (`toolsAllow` / `toolsDeny` globs + optional `editRegex`), and its instructions `body`. The type is stored for THIS session only and only your own workers can spawn it — a sibling orchestrator never sees it, and a daemon restart drops it (re-mint to spawn more).

After minting, spawn it: `spawn_worker({ workerType: "<name>", prompt: "…" })`. Returns `{ name }`.

Mint sparingly — prefer an existing type. A good `body` follows real prompt design: an environment map (upstream/downstream), an output contract, and if-then failure rules. The tool surface is a hard capability boundary: `toolsAllow` is exhaustive (anything not listed is denied), `toolsDeny` always subtracts, and `editRegex` confines file edits to matching paths — these are enforced at the gate and cannot be overridden by a policy rule.
