---
description: "MCP tool — send_message_to_parent"
---

Send your final report for the current directive to the orchestrator. Call this exactly ONCE per directive cycle, at the end.

The FIRST line of `text` must be a status signal that gets parsed:
  - `result: <one-line headline>` — task completed successfully
  - `needs input: <one-line ask>` — blocked on a decision a human must make
  - `failed: <one-line reason>` — task structurally impossible as framed

Then on subsequent lines, in order:
  1. What you did (2-3 bullets, no tool-output repetition)
  2. Verification you ran (`npm test passes`, `tsc clean`, etc.)
  3. Artifacts (changed file paths, commit hashes, IDs/URLs)
  4. Out-of-scope notes (one line, only if relevant)
  5. Handover (REQUIRED when working in an isolated worktree): `Handover: branch <eos-*>; verified by <command + verdict: passed|failed|blocked|unverified>; to try: <command>`

Do NOT use this for progress narration mid-task — narrate in plain text instead (the dashboard shows it live). Do NOT use this to ask clarifying questions before starting work; make a reasonable assumption and state it in your final report.

After this returns, end your turn. The orchestrator or the human operator may reply with a follow-up message; treat it as a fresh directive when it arrives.
