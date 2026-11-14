---
description: "MCP tool — browser_fill_form"
variables:
  - BROWSER_TYPE_TOOL
---

Fill several fields in one call: `fields` = `[{ref, value}, …]`, filled in order. ALWAYS prefer this over N separate {{BROWSER_TYPE_TOOL}} calls when a form has more than one field — one round trip, and no mid-form staleness from the page reacting between keystrokes.
