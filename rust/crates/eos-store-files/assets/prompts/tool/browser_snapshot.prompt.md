---
description: "MCP tool — browser_snapshot"
variables:
  - BROWSER_ACT_TOOL
  - BROWSER_FIND_TOOL
---

Read the page as an indented accessibility tree where each element carries a stable `@eN` ref — the ref every acting verb ({{BROWSER_ACT_TOOL}}, type, fill) takes. This is how you SEE a page in order to act on it.

Ref lifecycle: refs are minted per snapshot and die with the page. Re-snapshot after a navigation, form submit, or heavy DOM change — refs from a previous page are stale, and acting on one fails with a re-snapshot hint.

Cost control: `interactiveOnly` (default true) keeps the tree small; `selector` scopes to a subtree; `depth` truncates. To locate one known thing, {{BROWSER_FIND_TOOL}} is far cheaper than a full tree.
