---
description: "MCP tool — current_datetime"
---

Get the current date and time on the device running Eos (the user's Mac), including its timezone. Use it whenever you need the real wall-clock now — to resolve "today"/"tomorrow", timestamp something, reason about how long ago an event was, or convert to/from another timezone — instead of guessing from your training cutoff.

Takes no arguments.

Returns an object:
- `epochMs` — UTC instant in milliseconds (the unambiguous machine anchor).
- `iso` — ISO-8601 local time WITH the device offset, e.g. `2026-06-24T14:32:05.123+03:00`.
- `utc` — the same instant in UTC (Z form), e.g. `2026-06-24T11:32:05.123Z`.
- `timeZone` — the device IANA zone name, e.g. `Europe/Istanbul`.
- `utcOffsetMinutes` — minutes east of UTC at this instant (DST-correct), e.g. `180`.
- `formatted` — a human one-liner, e.g. `2026-06-24 14:32:05 UTC+03:00 (Europe/Istanbul)`.
