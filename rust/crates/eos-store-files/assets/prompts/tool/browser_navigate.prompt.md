---
description: "MCP tool — browser_navigate"
variables:
  - BROWSER_SNAPSHOT_TOOL
  - BROWSER_NEW_TAB_TOOL
---

Navigate the shared Eos browser: load a URL (`action:"url"` + `url`), go back/forward, or reload. Omit `tabId` for the active tab (the one the panel is viewing); if no tab is open, use {{BROWSER_NEW_TAB_TOOL}} first.

This is the ONE browser session the operator sees live in their panel — you are driving their screen, not a private session. Agent navigation can be fenced to an origin allowlist (`browser.allowedOrigins`); a refusal names the blocked origin — ask the operator instead of retrying.

After ANY navigation, element refs from earlier {{BROWSER_SNAPSHOT_TOOL}} calls are stale — re-snapshot before acting.
