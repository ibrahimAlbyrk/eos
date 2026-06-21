---
description: "Tool description — create_worker"
---

An available worker is a named, REUSABLE definition (defaults + tool surface + instructions body) — a blueprint, not a running worker; you spawn it as one or many workers. This tool DEFINES one; it does not start anything. You supply its defaults (model, effort, permission mode, persistence), its tool surface (`toolsAllow` / `toolsDeny` globs + optional `editRegex`), and its instructions `body`. The definition is stored for THIS session only and only your own spawns can use it — a sibling orchestrator never sees it, and a daemon restart drops it (define it again to spawn more).

To run it (once, or many times): `spawn_worker({ from: "<name>", prompt: "…" })`. Returns `{ name }`.

Define on **reuse OR longevity**. *Reuse:* you'll spawn the SAME shape (same method, contract, tool surface) ≥2× this session — author the framing once, then fan out N spawns that vary only a per-instance parameter (a research dimension, a file subtree). A swarm of N similar workers is what this is built for. *Longevity:* a SINGLE instance that is long-lived — persistent (many follow-up turns) or looped — so its framing persists in the system prompt across every turn, not just turn one. Do NOT define for one throwaway turn: that framing belongs in the `spawn_worker` prompt, and an inline tool surface (`toolsAllow` / `toolsDeny` / `editRegex`) fences a one-off's capability without a definition. Prefer an existing available worker over defining a new one.

**Specializing ≠ defining.** A rich, domain-framed PROMPT makes a worker a specialist whether or not you define it. This tool only decides whether that framing becomes REUSABLE — reach for it on reuse or longevity, never as a precondition for specializing at all.

The `body` becomes the worker's role instructions — composed ALONGSIDE the standard worker contract, which already supplies the `result:` / `needs input:` / `failed:` signal protocol, the report structure, and the Handover line. So the `body` must NOT restate any of those. Write only what is specific to THIS worker: an environment map (what it sits upstream/downstream of), an output contract for its deliverable, and one if-then rule per failure mode you can foresee. The built-in `general-purpose` definition is the shape to match.

The tool surface is a hard capability boundary: `toolsAllow` is exhaustive (anything not listed is denied), `toolsDeny` always subtracts, and `editRegex` confines file edits to matching paths — these are enforced at the gate and cannot be overridden by a policy rule. This boundary governs **capability** tools only (file/shell/external MCP). Eos's own control plane — the report-to-parent, peer, and sub-spawn tools — is exempt: a worker fenced to `toolsAllow: ['Read']` can still report back, and the peer tools stay gated solely by `collaborate`, never by this list.
