---
description: "MCP tool — browser_tabs"
---

List the open tabs: `{ tabs: [{ tabId, url, title, loading, audible, muted, … }] }`. The browser is ONE shared session — the operator's panel shows these same tabs. Use the list to pick the right `tabId` when several are open; verbs called without a `tabId` hit the active (foreground) tab — the one the panel is viewing.
