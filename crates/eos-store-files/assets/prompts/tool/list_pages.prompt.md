---
description: "MCP tool — list_pages"
variables:
  - READ_PAGE_TOOL
---

List the user's pages — markdown notes in the Eos side panel that you and the user both read and edit. By default only the pages of the project this chat works in; `all: true` lists every project's.

Returns `{ pages: [{ id, title, excerpt, openTasks, doneTasks, updatedAt, updatedBy }] }`, newest first. `updatedBy` is "the user", "you", or another agent. Read one in full with {{READ_PAGE_TOOL}}.
