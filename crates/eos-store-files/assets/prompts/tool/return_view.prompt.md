---
description: "Tool — return_view"
variables:
  - SUBMIT_RESULT_TOOL
---

Hand the run's answer back as a View, for a routine whose result is a view: the user sees it in Needs you and on the routine's page.

- `place`: `result` for the run's answer; `question` for a choice only the user can make.
- `view`: written as a visual answer is: `title`, `summary` (plain text, also what the phone shows), `ui`, `data`, `actions`.
- `bindings`: every `send` action of the view names what it runs: `{"<action id>": {"action": "routine.run_again", "args": {"item": "{data.lead.url}"}}}`. `args` may fill slots only from the view's own `data` (`{data.path}`) and from what the user types or picks (`{state.key}`). A button inside a list's rows also names that list, `"list": "data.stories"`, and its `args` read the row that was pressed as `{item.url}`. Only actions the routine may run are accepted. There is no chat outside a chat: `prefill` is refused.

The answer is the issue's id, or every problem with its path: fix them all and call this again. A `question` waits in Needs you until the user presses one of its buttons, and the answer then says what they pressed: go on with it. Then hand the result in with {{SUBMIT_RESULT_TOOL}}, kind `view`, naming the issue.

When NOT to use:
- For a routine whose result is not a view: hand the result in with {{SUBMIT_RESULT_TOOL}} alone.
- To show the user what you are doing: a View is the run's answer, not a progress note.
