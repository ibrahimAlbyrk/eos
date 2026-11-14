---
description: "MCP tool — append_to_page"
---

Add markdown to a page without touching the rest of it — the safe way to log findings or add checklist items (`- [ ] item`) while the user may be editing the same page. `under_heading` adds it at the end of that heading's section, creating the heading at the end of the page when it is missing.

Returns `{ id, rev }`.
