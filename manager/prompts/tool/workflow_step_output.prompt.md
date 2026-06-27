---
description: "MCP tool — workflow_step_output"
---

Emit this node's SINGLE typed result. This is the ONLY way your work leaves the node — your conversational messages are NOT the output. Call it EXACTLY once, at the end.

Arguments:
  - `output` — the node's result value. Match the node's declared output schema if it has one. Ignored when status is not `done`.
  - `status` — `done` (work complete, `output` is the result), `failed` (could not complete), or `needs-input` (blocked on missing input).
  - `reason` — one-line why. REQUIRED for `failed`/`needs-input`; becomes the node's failure output.

If you never call this, the node times out and fails. There is no `result:`/`failed:` first-line convention here — the `status` field carries that.
