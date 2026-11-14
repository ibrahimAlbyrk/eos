---
description: "MCP tool — present"
variables:
  - GENUI_CATALOG
---

Answer with a visual: a native, interactive view in the chat — cards, a map, a table, a chart, inputs — built from Eos's own components instead of a wall of markdown. You write the entities once in `data` and a compact markup in `ui` that only references them; Eos validates it, streams it to the user while you write it, and keeps it live: filters, sorting, tabs, steps and inputs run in the view without a turn. A `send` action posts the user's click back to you as a new turn: `[view action] <label>` and a JSON line with viewId, actionId, the item and the view's state.

Returns `view v_… rendered · …`, plus warnings to fix next time (no need to present again for them). A rejected call renders nothing and lists every problem with its path — fix them all and call again. After a view, say at most a sentence; never repeat its content in text.

{{GENUI_CATALOG}}
