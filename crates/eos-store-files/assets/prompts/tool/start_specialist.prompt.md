---
description: "Tool — start_specialist"
variables:
  - MESSAGE_SPECIALIST_TOOL
---

Start one specialist of the routine's team on a task. `agent` is the specialist's key as your brief lists it; `task` is what it should do now. Its model, tools and folder are set by the routine: you choose only the task.

The specialist reports back to you as a message when it is done. Start the specialists whose parts do not wait on each other at once, then wait for their reports.

When NOT to use:
- For a specialist already working: give it more with {{MESSAGE_SPECIALIST_TOOL}}.
