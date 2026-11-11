---
description: "MCP tool — present_app"
variables:
  - PRESENT_TOOL
---

Show the user a small app you write: one self-contained HTML document (inline CSS and JS) that runs in a sandboxed frame in the chat — a calculator, a timer, a game, a simulator, a bespoke visual. Use it only when the user asks for a tool, a game or a calculator, or for a look {{PRESENT_TOOL}}'s components can't express; anything they can show belongs in {{PRESENT_TOOL}}.

The sandbox:
- No network at all: fetch, XHR, WebSocket, external scripts, styles, fonts and http images are blocked — inline everything, images and sounds only as data: URIs.
- No eval or new Function. localStorage, sessionStorage and cookies throw — keep state in memory (or wrap access in try/catch). alert/confirm/prompt do nothing. Forms can't submit anywhere — handle submit in JS. No popups, no navigation.

`window.eos` inside the app:
- `eos.send(text)` asks the user to send `text` to you as their message; a Promise that rejects if they dismiss it. At most one every 2 s, one waiting at a time. The app can't talk to you without that confirmation.
- `eos.openLink(url)` opens an http(s) link in Eos's browser panel.
- `eos.resize(px)` sets the frame height and stops auto-sizing.
- `eos.hostContext` (theme, locale, time zone, size) and a window `eos:hostcontext` event when it changes.

Look: Eos's chat is dark — theme variables are set for you: `--color-background-primary|secondary|tertiary`, `--color-text-primary|secondary|tertiary`, `--color-border-primary|secondary`, `--color-ring-primary`, `--font-sans`, `--font-mono`, `--border-radius-xs…full`, `--eos-accent` and `--eos-blue|green|amber|red|violet|teal`. The body starts with margin 0; use 13–14px text and one accent.

- height: the frame's height in px (200–720). Leave it out and the frame follows the document's own height (160–720); a full-height (100vh) layout must declare it.
- summary: what the app is and does, in plain text — the fallback where apps don't run.

Returns `view v_… rendered · app`. A rejected call lists each problem — fix them and call again. If the user turned apps off, the result says so: answer without one.
