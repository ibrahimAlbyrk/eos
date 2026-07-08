---
description: "MCP tool — schedule_prompt"
---

Schedule a prompt to be delivered into your OWN chat at a future wall-clock instant. When the time arrives the daemon dispatches the text as a normal turn — the same as if it had just been sent to you — so it wakes you up to act on it. Use this to defer work you can't do yet: re-check something after a delay, resume a task once an external process should be done, or leave yourself a timed reminder.

Provide the text plus EXACTLY ONE of:
- `fireAtEpochMs` — an absolute fire time as a UTC epoch-milliseconds instant. Get a valid anchor from the `current_datetime` tool's `epochMs` and add to it.
- `delayMinutes` — fire this many minutes from now. Resolved against the device clock, so you don't need to know the current time.

Passing both, or neither, is rejected with a message — pick one.

The prompt fires once. If you are mid-turn when it comes due it is queued and delivered at your next idle (it never interrupts a running turn). A prompt that fires well after its scheduled time is still delivered, tagged late.

Returns the created row: `{ id, workerId, text, fireAt, status, createdAt, firedAt, meta }`. Keep the `id` if you may want to cancel it before it fires.
