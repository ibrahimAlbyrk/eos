---
description: "MCP tool — browser_act"
variables:
  - BROWSER_SNAPSHOT_TOOL
  - BROWSER_FIND_TOOL
---

Act on one element by its `@eN` ref: click, hover, focus, check, or uncheck. Get the ref from {{BROWSER_SNAPSHOT_TOOL}} or {{BROWSER_FIND_TOOL}} first — never guess a ref. A stale ref (the page changed since the snapshot) fails with a re-snapshot hint.

`includeSnapshot:true` returns a fresh snapshot with the result — it is the token-expensive part, so request it only when you need to see the outcome; otherwise verify with a cheap read (browser_get / browser_find).
