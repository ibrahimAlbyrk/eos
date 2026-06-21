---
description: "Tool description — create_worker"
---

An available worker is a named, REUSABLE definition (defaults + tool surface + instructions body) — a blueprint, not a running worker; you spawn it as one or many workers. This tool DEFINES one; it does not start anything. You supply its defaults (model, effort, permission mode, persistence), its tool surface (`toolsAllow` / `toolsDeny` globs + optional `editRegex`), and its instructions `body`. The definition is stored for THIS session only and only your own spawns can use it — a sibling orchestrator never sees it, and a daemon restart drops it (define it again to spawn more).

To run it (once, or many times): `spawn_worker({ from: "<name>", prompt: "…" })`. Returns `{ name }`.

Define only on **reuse or longevity** — the full reuse-vs-longevity decision (and the GOOD/WEAK body examples) is in §Available workers. Prefer an existing available worker over defining a new one; a one-off's framing belongs in the `spawn_worker` prompt (with an inline `toolsAllow`/`toolsDeny`/`editRegex` fence), not a definition.

The `body` is role instructions only — composed ALONGSIDE the standard worker contract, so it must NOT restate the `result:` / `needs input:` / `failed:` signal protocol, the report structure, or the Handover line. What to put in it (and the GOOD/WEAK worked examples) → §Available workers.

The tool surface is a hard capability boundary: `toolsAllow` is exhaustive (anything not listed is denied), `toolsDeny` always subtracts, and `editRegex` confines file edits to matching paths — these are enforced at the gate and cannot be overridden by a policy rule. This boundary governs **capability** tools only (file/shell/external MCP). Eos's own control plane — the report-to-parent, peer, and sub-spawn tools — is exempt: a worker fenced to `toolsAllow: ['Read']` can still report back, and the peer tools stay gated solely by `collaborate`, never by this list.
