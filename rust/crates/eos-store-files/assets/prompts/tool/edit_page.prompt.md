---
description: "MCP tool — edit_page"
variables:
  - READ_PAGE_TOOL
  - APPEND_TO_PAGE_TOOL
  - SET_PAGE_TASK_TOOL
---

Replace one exact passage of a page, like a find-and-replace. Copy `old_text` from {{READ_PAGE_TOOL}}; it must occur exactly once, or the call fails and nothing changes. An empty `new_text` deletes the passage. To add text use {{APPEND_TO_PAGE_TOOL}}; to tick a checklist item use {{SET_PAGE_TASK_TOOL}}.

Returns `{ id, rev }`.
