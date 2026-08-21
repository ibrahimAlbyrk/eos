---
description: "MCP tool — browser_find"
variables:
  - BROWSER_SNAPSHOT_TOOL
  - BROWSER_ACT_TOOL
---

The cheap way to locate one thing without a full snapshot: match visible text (or `/regex/`) and get back the matching elements with their `@eN` refs, ready for {{BROWSER_ACT_TOOL}}. Prefer this over {{BROWSER_SNAPSHOT_TOOL}} whenever you already know what you are looking for ("the Submit button", "the price").
