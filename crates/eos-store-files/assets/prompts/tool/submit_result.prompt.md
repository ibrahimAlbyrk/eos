---
description: "Tool — submit_result"
variables:
  - REPORT_FAILURE_TOOL
---

Hand in the run's result. Eos checks it and then, as the user allowed, shows it, asks the user or sends it; you never send anything yourself.

- `kind`: what the result is, as the brief's "What it makes" names it; `nothing` when there is nothing worth sending ("no new mail worth a summary").
- `headline`: one line the user reads first.
- `body`: the result in the shape the brief asks for (for a review, its parts: summary, comments, verdict), or plain text.
- `files`: paths of files the result carries, if any.

Call it once, at the end. A checker may send the result back with what must be fixed: fix it and call this again. When the work cannot be done, call {{REPORT_FAILURE_TOOL}} instead.
