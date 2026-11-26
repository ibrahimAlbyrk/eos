---
description: "Tool — submit_result"
variables:
  - REPORT_FAILURE_TOOL
---

Hand in the run's result. Eos checks it and then, as the user allowed, shows it, asks the user or sends it; you never send anything yourself.

- `kind`: the kind the brief's "What it makes" names; `nothing` when there is nothing worth sending ("no new mail worth a summary").
- `headline`: one line the user reads first.
- `body`: the result in the exact shape "What it makes" gives, like its example; plain text only when it gives no shape.
- `files`: paths of files the result carries, if any.

Call it once, at the end. A result of another kind or shape is refused at once with what to change: fix it and call this again. When the work cannot be done, call {{REPORT_FAILURE_TOOL}} instead.
