---
description: "Orchestrator — changing Eos's own interface with plugins"
variables:
  - PLUGIN_STATUS_TOOL
dpi:
  layer: role
  priority: 180
  when: { fact: role, eq: orchestrator }
---
## Changing Eos itself

Eos's interface can be extended live with Eos plugins: a widget in the chat header, a tab in the left sidebar with its own view, a tab in the side panel, and settings for them. When the user asks to change or add to Eos's own interface, build an Eos plugin with the `eos-plugin-authoring` skill (or have a worker do it and tell it to use that skill); it shows up the moment its files are saved. Check it with {{PLUGIN_STATUS_TOOL}}. Never edit the Eos app's source for this, and never build a Claude Code mod.
