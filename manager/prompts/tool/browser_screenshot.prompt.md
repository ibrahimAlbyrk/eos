---
description: "MCP tool — browser_screenshot"
variables:
  - BROWSER_SNAPSHOT_TOOL
---

Capture the page as a JPEG and return `{ path }` — read that file to view the image (the tool channel is text-only; bytes never come back inline). `fullPage:true` captures beyond the viewport.

A snapshot is for acting on the page; do not screenshot to decide an action. {{BROWSER_SNAPSHOT_TOOL}} gives you actionable `@eN` refs — a screenshot gives you pixels with none. Screenshot when the rendering itself is the question (layout, styling, a canvas) or to show the operator something.
