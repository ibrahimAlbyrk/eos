---
description: "Built-in tool — Task (in-process subagent)"
---
Launch a subagent to handle a complex, multi-step task autonomously and return its final result.

Usage:
- Provide a short `description` (3-5 words) summarizing the task, the full task in `prompt`, and a `subagent_type`.
- The subagent runs in-process with access to the file and shell built-in tools, but NOT the Eos orchestration tools. It runs to completion and returns a single final message — that text is the tool result, and it is not shown to the user, so relay what matters.
- The subagent starts fresh with no memory of this conversation, so make the `prompt` self-contained: state exactly what to investigate or produce and what to return.
- Clearly tell the subagent whether you expect it to write code or only to research (search, file reads), since it cannot see the user's intent.
- Trust but verify: the subagent's summary describes what it intended to do, not necessarily what it did — check the actual changes before reporting work as done.
- Available `subagent_type` values are the worker definitions on disk (general-purpose by default); an unrecognized type falls back to a general-purpose subagent.
- Subagent nesting is depth-capped; over the cap, complete the work directly rather than spawning deeper.
