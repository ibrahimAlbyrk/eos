---
description: "Tool — report_failure"
variables:
  - SUBMIT_RESULT_TOOL
---

End the run as failed, with the reason in one plain sentence (`reason`) the user will read: "The pull request was closed before I could review it."

When NOT to use:
- When there is simply nothing to send: that is a result. Call {{SUBMIT_RESULT_TOOL}} with kind `nothing`.
- To ask the user something: work with what you have, and say what you assumed in the result.
