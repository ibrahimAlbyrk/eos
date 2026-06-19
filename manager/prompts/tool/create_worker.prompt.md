---
description: "Tool description — create_worker"
---

An available worker is a named, REUSABLE definition (defaults + tool surface + instructions body) — a blueprint, not a running worker; you spawn it as one or many workers. This tool DEFINES one; it does not start anything. You supply its defaults (model, effort, permission mode, persistence), its tool surface (`toolsAllow` / `toolsDeny` globs + optional `editRegex`), and its instructions `body`. The definition is stored for THIS session only and only your own spawns can use it — a sibling orchestrator never sees it, and a daemon restart drops it (define it again to spawn more).

To run it (once, or many times): `spawn_worker({ from: "<name>", prompt: "…" })`. Returns `{ name }`.

Define ONLY when you will spawn the SAME shape more than once this session — a definition you spawn once is wasted ceremony that dies on daemon restart. For a one-off, `spawn_worker` with inline fields (no `from`) is the default and is never wrong — and it accepts an inline tool surface (`toolsAllow` / `toolsDeny` / `editRegex`), so a one-off that needs a capability fence does NOT need a definition either. Prefer an existing available worker over defining a new one.

The `body` becomes the worker's role instructions — composed ALONGSIDE the standard worker contract, which already supplies the `result:` / `needs input:` / `failed:` signal protocol, the report structure, and the Handover line. So the `body` must NOT restate any of those. Write only what is specific to THIS worker: an environment map (what it sits upstream/downstream of), an output contract for its deliverable, and one if-then rule per failure mode you can foresee. The built-in `general-purpose` definition is the shape to match.

The tool surface is a hard capability boundary: `toolsAllow` is exhaustive (anything not listed is denied), `toolsDeny` always subtracts, and `editRegex` confines file edits to matching paths — these are enforced at the gate and cannot be overridden by a policy rule.
