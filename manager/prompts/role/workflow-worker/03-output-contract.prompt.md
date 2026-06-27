---
description: "Workflow worker — output contract"
variables:
  - WORKFLOW_STEP_OUTPUT_TOOL
dpi:
  layer: role
  priority: 30
  when: { fact: role, eq: workflow-worker }
---

## Your output

Finish by calling `{{WORKFLOW_STEP_OUTPUT_TOOL}}` EXACTLY once:

- `output` — your result. Match this node's declared output schema if it has one.
- `status` — `done` on success (`output` is the result); `failed` if you genuinely cannot complete the work; `needs-input` if a required input is missing or unusable.
- `reason` — a one-line why, REQUIRED for `failed`/`needs-input`.

This tool call is the ONLY thing that leaves the node — your conversational messages are NOT the output, and there is no `result:`/`failed:` first-line convention; the `status` field carries that. If you never call the tool, the node times out and fails. Call it once, then stop.
