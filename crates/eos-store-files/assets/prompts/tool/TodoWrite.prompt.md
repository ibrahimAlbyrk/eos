---
description: "Built-in tool — TodoWrite"
---
Create and manage a structured task list for the current session; the list is shown live
to the user as you work.

Use it for multi-step or non-trivial work (roughly 3+ distinct steps), when the user
lists several tasks, or when they ask for a todo list. Skip it for a single
straightforward step or a purely conversational/informational request — just do the
task.

Each todo has `content` (imperative: "Run tests"), `activeForm` (present continuous,
shown while running: "Running tests"), and `status` (`pending`, `in_progress`,
`completed`).

Managing the list:
- Keep one task `in_progress` at a time; mark it before starting that work.
- Mark a task `completed` immediately when it is fully done — failing tests, partial
  implementation, or unresolved errors keep it `in_progress`, with a new task for the
  blocker.
- Update statuses in real time, and remove tasks that are no longer relevant.
