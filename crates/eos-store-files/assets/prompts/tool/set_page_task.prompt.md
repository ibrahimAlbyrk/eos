---
description: "MCP tool — set_page_task"
---

Tick one checklist item (`- [ ] …`) on a page, or untick it with `done: false`, matched by its text. Tick an item as soon as you finish the work it names — the user follows progress on the page. Fails without changing anything when no item, or more than one, matches.

Returns `{ id, rev }`.
