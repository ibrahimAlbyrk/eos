---
description: "Orchestrator — available workflows (the live run-stored catalog)"
variables:
  - AVAILABLE_WORKFLOWS_CATALOG
  - WORKFLOW_TOOL
dpi:
  layer: role
  priority: 155
  when: { fact: role, eq: orchestrator }
---

# Available workflows

Catalogued workflow graphs — built-ins plus any operator/project files in
`~/.eos/workflows/` and definitions you create this session. You launch one by
name with `{{WORKFLOW_TOOL}}` (`run-stored {from}`); the operator can also run the
same graphs zero-LLM via `eos workflow run <name>` or the node-editor UI. Prefer
running a catalogued graph by name over re-authoring its shape inline. See
§Workflows for what the engine is and how to author one.

{{#if AVAILABLE_WORKFLOWS_CATALOG}}
{{AVAILABLE_WORKFLOWS_CATALOG}}
{{/if}}

The snapshot above is fixed at launch; a workflow you `create` mid-session won't
appear here but is still runnable by name.
