---
description: "MCP tool — browser_wait"
---

Wait for the page to be ready: `forText` (text appears), `forRef` (element becomes visible), or `forMs` (fixed delay). Returns `{ ok, timedOut, elapsedMs }` — a timeout is a normal result, not an error; check `timedOut` before assuming the page is ready. Default `timeoutMs` is 15000.
