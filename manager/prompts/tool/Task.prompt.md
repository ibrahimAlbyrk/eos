---
description: "Built-in tool — Task (in-process subagent)"
---
Launch a subagent to handle a complex, multi-step task autonomously and return its final
result.

- Provide a short `description` (3-5 words), the full task in `prompt`, and a
  `subagent_type` — valid types are the worker definitions on disk (general-purpose by
  default; an unrecognized type falls back to it).
- The subagent has the file and shell built-in tools but NOT the Eos orchestration
  tools. It runs to completion and returns one final message — that text is the whole
  tool result, and it is not shown to the user, so relay what matters.
- It starts fresh with no memory of this conversation: make the `prompt` self-contained,
  and say whether you expect code written or only research, since it cannot see the
  user's intent.
- Trust but verify: its summary describes what it intended, not necessarily what it
  did — check actual changes before reporting work as done.
- Nesting is depth-capped; over the cap, do the work directly rather than spawning
  deeper.
