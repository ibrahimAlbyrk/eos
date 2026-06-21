---
description: "MCP tool — send_message_to_parent"
---

Send your final report for the current directive to the orchestrator. Call this exactly ONCE per directive cycle, at the end.

The FIRST line of `text` must be a status signal that gets parsed:
  - `result: <one-line headline>` — task completed successfully
  - `needs input: <one-line ask>` — blocked on a decision a human must make
  - `failed: <one-line reason>` — task structurally impossible as framed

Then structure the body exactly as the Reporting contract in your system prompt specifies (Outcome → Artifacts → Verification → Handover) — that contract is authoritative; this tool does not redefine the body or the Handover shape. Do NOT narrate process.

Do NOT use this for progress narration mid-task — narrate in plain text instead (the dashboard shows it live). Do NOT use this to ask clarifying questions before starting work; make a reasonable assumption and state it in your final report.

After this returns, end your turn. The orchestrator or the human operator may reply with a follow-up message; treat it as a fresh directive when it arrives.
