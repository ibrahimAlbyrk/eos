---
description: "MCP tool — ask_user"
variables:
  - NOTIFY_USER_TOOL
---

Ask the operator a question and BLOCK until they answer in the dashboard. This is the replacement for the builtin AskUserQuestion tool, which is disabled in Eos.

Use it only when the answer changes what you do next and you cannot resolve it from the request, prior reports, or sensible defaults: choosing between expensive-to-undo decompositions, a missing requirement, a destructive-action confirmation. Do NOT use it for progress updates (chat reply), completion/blocked taps ({{NOTIFY_USER_TOOL}}), or anything you can decide yourself.

The call returns the chosen labels (or free text) per question. The operator can also dismiss without answering — proceed on your best judgment then. There is no timeout; the answer may arrive much later, and your turn stays open until it does.
