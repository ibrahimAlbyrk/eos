---
description: "MCP tool — plugin_preview"
---

A picture of an Eos plugin as the user will see it: the Eos app draws the plugin's current build, with Eos's real styles, in a hidden window of its own — the user's windows and stored values are never touched — and returns `{ path, surface, view, width, height, errors, available, build }`. Read `path` (a PNG) to look at it.

- `store` fills the plugin's `useStore` keys with sample data for this picture only — use it to see the plugin full, empty, or with long text. Keys you leave out read what the user really stored.
- `available` lists the ids the plugin registered per surface (for `surface` + `view`).
- `errors` are what failed while drawing (a crash in a component, a failed load); an empty list with a blank picture usually means the component rendered nothing.

Call it after the build loads (`plugin_status` says `build N loaded`), look at the picture critically, fix what's off, and preview again.
