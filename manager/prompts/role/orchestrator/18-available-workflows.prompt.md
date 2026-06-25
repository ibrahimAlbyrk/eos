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

Catalogued `WorkflowDefinition`s you can launch by name with `{{WORKFLOW_TOOL}}`
(`run-stored {from}`) — built-ins plus any user/project files and definitions you
create this session. See §Workflows for what a workflow is and how to author one.

{{#if AVAILABLE_WORKFLOWS_CATALOG}}
{{AVAILABLE_WORKFLOWS_CATALOG}}
{{/if}}

The snapshot above is fixed at launch; a workflow you `create` mid-session won't
appear here but is still runnable by name.
