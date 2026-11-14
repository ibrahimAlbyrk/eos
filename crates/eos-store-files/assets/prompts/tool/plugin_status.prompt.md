---
description: "MCP tool — plugin_status"
---

Where an Eos plugin stands. Eos plugins change Eos's own interface (header widgets, sidebar tabs, side-panel tabs); load the `eos-plugin-authoring` skill before writing one.

With no `id`: `{ pluginsDir, plugins: [{ id, name, state, error }] }` — `pluginsDir` is the folder plugins live in (one subfolder per plugin).

With an `id`: waits (up to ~5 s) for Eos to rebuild the plugin from its files and for the open Eos windows to load it, then returns `{ id, dir, state, buildError, build, window, settings }`. `state` is active, disabled or error; `buildError` is the compiler's or the manifest's complaint (file:line: message); `window` says whether the build loaded in the app or failed there (a runtime error, with its message). Call it after every change you make to a plugin, and fix what it reports before telling the user it's done.
