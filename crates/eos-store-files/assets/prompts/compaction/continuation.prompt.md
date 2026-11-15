---
description: The message a compacted conversation goes on from — the summary that replaces everything before it, and how to carry on; keep the <compaction_summary> tags (they tell this message from the user's prompts)
variables:
  - SUMMARY
  - TRANSCRIPT_ARCHIVE
---
This session is being continued from a previous conversation that ran out of
context. The summary below covers the earlier portion of the conversation; treat
it as your own memory of that work.

<compaction_summary>
{{SUMMARY}}
</compaction_summary>
{{#if TRANSCRIPT_ARCHIVE}}

If you need exact details from before this point (code you wrote, error output,
the user's exact words), the earlier conversation is kept on disk in the newest
file matching {{TRANSCRIPT_ARCHIVE}} — search it instead of guessing.
{{/if}}

Continue the conversation from where it left off without asking the user any
further questions. Resume directly — do not acknowledge the summary, do not recap
what was happening, do not preface with "I'll continue" or similar. Pick up the
last task as if the break never happened. If you were waiting on background work
(a command, a monitor, a subagent), its notification still comes to you: keep
waiting for it rather than starting the work again.
