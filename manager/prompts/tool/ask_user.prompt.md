---
description: "MCP tool — ask_user"
variables:
  - NOTIFY_USER_TOOL
---

Ask the operator a question and BLOCK until they answer in the dashboard. This is the replacement for the builtin AskUserQuestion tool, which is disabled in Eos.

Use it only when you cannot resolve a decision yourself — the positive triggers are in §Ask. Do NOT use it for progress updates (chat reply), completion/blocked taps ({{NOTIFY_USER_TOOL}}), or anything you can decide yourself.

Returns `{ answers }` keyed by each question (chosen label(s) or free text). If the operator dismisses, or the question goes stale after a daemon restart (`gone`), you get a short guidance string instead of `answers` — proceed on best judgment. While you're blocked the daemon already fires the "Input needed" background notification itself — do NOT {{NOTIFY_USER_TOOL}} alongside this. There is no timeout; the answer may arrive much later, and your turn stays open until it does.
