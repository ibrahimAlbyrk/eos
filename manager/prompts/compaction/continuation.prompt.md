---
description: Seed of the session that replaces a compacted one — the summary the agent continues from; rides along with the next message (runs no turn by itself)
variables:
  - SUMMARY
  - TRANSCRIPT_PATH
---
This session continues an earlier conversation that was compacted to free up
context. The summary below covers everything before this point; treat it as your
own memory of that work.

<compaction_summary>
{{SUMMARY}}
</compaction_summary>
{{#if TRANSCRIPT_PATH}}

If you need exact details from before the compaction (code you wrote, error
output, the user's exact words), the full earlier transcript is still on disk at
{{TRANSCRIPT_PATH}} — search it instead of guessing.
{{/if}}

The next message follows. Continue from where the work left off, and do not
recap this summary back to the user.
