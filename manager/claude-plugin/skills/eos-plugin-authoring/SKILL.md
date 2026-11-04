---
name: eos-plugin-authoring
description: Build or change an Eos plugin — a live addition to Eos's own interface (the app you are running in). Use whenever the user asks to add, change or remove something in Eos itself, such as a widget or clock in the chat header, a tab in the left sidebar with its own view (notes, a dashboard, a timer), a tab in the right side panel, or settings for such a thing. Not for Claude Code mods and not for editing the Eos source.
---

# Eos plugins

An Eos plugin is a folder of a few files. Eos builds it and shows it in every open Eos window **the moment you save** — no restart, no install step, no approval. Each later save replaces it in place. The user turns it on/off and changes its settings under Settings › Plugins.

## The loop

1. **Find the folder.** Call `plugin_status` with no id (load it with ToolSearch if it isn't loaded). It returns `pluginsDir` and the plugins already there. If the user asks to change an existing plugin, edit that one instead of making a new one.
2. **Write the files** with Write/Edit into `<pluginsDir>/<id>/`. The id is the folder name: lowercase letters, digits, `-` (e.g. `clock`, `sticky-notes`).
3. **Check it.** Call `plugin_status` with the id. It waits for the rebuild and for the app to load it. Fix every `buildError` and every `window` failure, then check again.
4. **Tell the user** where it is ("top right of every chat", "Sticky notes in the left sidebar") and which settings it has.

Stop at step 3 until `state` is `active` and `window` says the build loaded. If `window` says it's not loaded in any window yet, the Eos app may be closed — say so; the plugin will appear when it opens.

## Files

```
<pluginsDir>/<id>/
  plugin.json   the manifest (required)
  ui.jsx        the UI entry (or ui.tsx / ui.js / ui.ts)
  *.css         styles, imported from ui.jsx
  other .js/.jsx/.svg files you import
```

### plugin.json

```json
{
  "id": "clock",
  "name": "Clock",
  "description": "The time, in the top-right corner of every chat.",
  "version": "0.1.0",
  "icon": "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3 2\"/></svg>",
  "settings": {
    "seconds": { "type": "boolean", "title": "Show seconds", "default": false },
    "format":  { "type": "select", "title": "Format", "default": "24h", "options": [{ "value": "24h", "label": "24-hour" }, { "value": "12h", "label": "12-hour" }] }
  }
}
```

- `id` must equal the folder name. `name` ≤ 60 chars, `description` ≤ 300.
- `icon` (optional): an inline 24×24 SVG using `currentColor`, shown in Settings › Plugins.
- `settings` (optional) become the plugin's page in Settings › Plugins. Types: `boolean`, `string` (`placeholder`, `multiline`), `number` (`min`, `max`, `step` — with both min and max it's a slider), `select` (`options: [{value, label}]`). Always give a `default`. Keys: letters, digits, `_ . -`.
- `"experimental": true` makes it start turned off. Don't use it unless asked.
- Only add settings the user would actually change.

### ui.jsx

The default export is `activate(eos)`. It runs when the plugin loads; everything it adds through `eos` is removed automatically when the plugin reloads, is turned off or deleted. Define components inside or outside `activate` — inside is handy because they can use `eos`.

```jsx
import { useState, useEffect } from "react";
import "./style.css";

export default function activate(eos) {
  eos.headerRight({ id: "clock", Component: Clock, once: true });
}
```

Imports: only your own files and `react`, `react/jsx-runtime`, `react-dom`. **No npm packages** (nothing else resolves) — write what you need. JSX works in `.jsx`/`.tsx`. CSS files you import are loaded with the plugin. `.svg` imports give the SVG text; `.png/.jpg/.gif/.webp` give a data URL.

## The `eos` API

| Call | Adds | Component props |
|---|---|---|
| `eos.headerRight({ id, Component, once?, order? })` | A widget on the right of a chat's header, left of the panel buttons. `once: true` = only in the top-right pane (one per window) — use it for anything global (a clock, a status); without it every split pane gets one (use for per-chat things). | `{ worker, live, topRight }` — `worker` is the pane's agent row or null (new chat) |
| `eos.sidebarNav({ id, label, icon, view, order? })` | A row in the left sidebar under New task / Changes / Archive that opens main view `view`. `icon`: a 15×15 SVG element. Built-in rows use order 10/20/30. | — |
| `eos.mainView({ id, Component })` | A view that takes the chat area while open (the side panel stays beside it). Open it from a `sidebarNav` row, or `eos.openMainView(id)`. | `{ live }` |
| `eos.sidePanelTab({ id, label, icon, Component, launcher? })` | A tab type in the right side panel. `launcher: true` lists it in the panel's new-tab page. | `{ live, tabId }` |
| `eos.openMainView(id)` / `eos.closeMainView(id)` / `eos.isMainViewOpen(id)` | Show / hide one of your main views. | |
| `eos.css(text)` | Extra styles (prefer importing a .css file). | |
| `eos.notify.warning(msg)` / `eos.notify.error(msg)` | A system notification (only while the window isn't focused). | |

Hooks — call inside your components:

| Hook | Returns |
|---|---|
| `eos.useSetting(key)` | The current value of a manifest setting (default filled in). Re-renders when the user changes it. |
| `eos.useSettings()` | All of them, as an object. |
| `eos.useStore(key, initial)` | `[value, setValue]` like `useState`, but **kept across restarts** and synced between windows. `setValue(next)` or `setValue(prev => next)`. Values are JSON. Use it for anything the user creates (notes, lists, timers' state). |

`live.workers` (from `{ live }`) is the list of agent rows (`id`, `name`, `state`, `cwd`, …), if a view needs it.

Ids you pass (`id`, `view`) are your own — Eos namespaces them per plugin.

## Picking where it goes

| The user says | Use |
|---|---|
| "top right", "in the header", "next to the panel button", a small always-visible indicator | `headerRight` (with `once: true` unless it's about that chat) |
| "a tab in the left sidebar", "next to New task / Archive", a page of its own | `sidebarNav` + `mainView` |
| "in the side panel", "next to Files / Terminal / Changes", a tool beside the chat | `sidePanelTab` (`launcher: true`) |
| "a setting for …" | a `settings` entry in plugin.json, read with `useSetting` |

If it's unclear, pick the closest and say where you put it.

## Making it look like Eos

Eos is dark, quiet and dense. Match it:

- **Colors only from tokens** — never hard-code grays: backgrounds `var(--bg)`, `var(--panel)`, `var(--raised)`, `var(--chip)`; text `var(--fg-strong)`, `var(--fg)`, `var(--fg-mid)`, `var(--fg-dim)`, `var(--fg-faint)`; lines `var(--line)`; accents `var(--accent)` (text on it: `var(--accent-fg)`), `var(--ok)`, `var(--warn)`, `var(--err)`, `var(--amber)`, `var(--violet)`. Soft accent fills: `color-mix(in srgb, var(--accent) 14%, transparent)`. (A deliberately colorful thing, like sticky notes, may use its own palette.)
- **Glass chips/buttons**: `background: var(--lg-chip-bg); box-shadow: var(--lg-chip-sh);` — hover/selected: `var(--lg-chip-on-bg)`, `var(--lg-chip-on-sh)`.
- **Type**: `font-family: var(--font-ui)` (default) or `var(--font-mono)` for numbers/code; sizes `var(--text-xs|sm|base|md|lg|xl)`; numbers that change: `font-variant-numeric: tabular-nums`.
- **Radius**: `var(--r-row)` buttons/rows, `var(--r-card)` cards, `var(--r-pill)` pills.
- **Header widgets** are at most 26 px tall, `--text-xs`/`--text-sm`, no borders — like a chip.
- **Main views**: start with Eos's own header row so the view lines up with the rest of the app, then your content in a scrolling area:

```jsx
<div className="my-view">
  <div className="pane-head pane-head--topleft pane-head--topright">
    <span className="pane-head-inset" aria-hidden="true" />
    <div className="crumb"><span className="cur">Sticky notes</span></div>
    {/* header buttons here, e.g. <button className="my-add">+ New</button> */}
  </div>
  <div className="my-body">…</div>
</div>
```
```css
.my-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.my-body { flex: 1; overflow: auto; padding: 24px 28px; }
```

- **Prefix every class** with your plugin's id (e.g. `.clock-…`, `.sn-…`) so nothing collides with Eos or other plugins. Don't restyle Eos's own classes.
- Empty states: one quiet line in `var(--fg-faint)`, plus the action to start.

## Rules

- Everything goes inside `<pluginsDir>/<id>/`. Never edit the Eos app's source, `~/.eos` files outside your plugin folder, or Claude Code's settings/mods for this.
- No top-level side effects in ui.jsx — start timers, listeners and fetches inside components (`useEffect`, with cleanup) so a reload leaves nothing behind.
- No network calls to the Eos daemon and no `window.__EOS_*`; use `useStore` / `useSetting`.
- Keep it small and readable; one plugin per user request unless they ask to extend an existing one.
- Don't add `experimental`, permissions or settings nobody asked for.

## Examples

### Clock (header widget + settings)

`plugin.json` as above. `ui.jsx`:

```jsx
import { useEffect, useState } from "react";
import "./clock.css";

export default function activate(eos) {
  function Clock() {
    const seconds = eos.useSetting("seconds");
    const hour12 = eos.useSetting("format") === "12h";
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
      const t = setInterval(() => setNow(new Date()), 1000);
      return () => clearInterval(t);
    }, []);
    const text = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12 });
    return <span className="clock-chip" title={now.toLocaleDateString()}>{text}</span>;
  }
  eos.headerRight({ id: "clock", Component: Clock, once: true, order: 0 });
}
```

`clock.css`:

```css
.clock-chip {
  display: inline-flex; align-items: center; height: 26px; padding: 0 10px;
  border-radius: var(--r-row); color: var(--fg-mid);
  font-family: var(--font-mono); font-size: var(--text-xs); font-variant-numeric: tabular-nums;
  background: var(--lg-chip-bg); box-shadow: var(--lg-chip-sh);
}
```

### Sticky notes (sidebar tab + main view + stored data)

`plugin.json`:

```json
{
  "id": "sticky-notes",
  "name": "Sticky notes",
  "description": "A board of colored notes in the left sidebar.",
  "version": "0.1.0",
  "settings": {
    "palette": { "type": "select", "title": "Colors", "default": "warm", "options": [{ "value": "warm", "label": "Warm" }, { "value": "cool", "label": "Cool" }] }
  }
}
```

`ui.jsx`:

```jsx
import "./notes.css";

const NoteIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
    <path d="M3 2.5h10v7l-3.5 4H3z" /><path d="M9.5 13.5v-4H13" />
  </svg>
);

export default function activate(eos) {
  function Board() {
    const [notes, setNotes] = eos.useStore("notes", []);
    const palette = eos.useSetting("palette");
    const add = () => setNotes((ns) => [{ id: crypto.randomUUID(), text: "", color: ns.length % 4 }, ...ns]);
    const edit = (id, text) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, text } : n)));
    const remove = (id) => setNotes((ns) => ns.filter((n) => n.id !== id));
    return (
      <div className="sn">
        <div className="pane-head pane-head--topleft pane-head--topright">
          <span className="pane-head-inset" aria-hidden="true" />
          <div className="crumb"><span className="cur">Sticky notes</span></div>
          <button className="sn-add" onClick={add}>+ New note</button>
        </div>
        <div className={`sn-grid sn-${palette}`}>
          {notes.length === 0 && <div className="sn-empty">No notes yet — add one.</div>}
          {notes.map((n) => (
            <div key={n.id} className={`sn-note c${n.color}`}>
              <textarea value={n.text} placeholder="Write…" onChange={(e) => edit(n.id, e.target.value)} />
              <button className="sn-del" title="Delete" onClick={() => remove(n.id)}>×</button>
            </div>
          ))}
        </div>
      </div>
    );
  }
  eos.mainView({ id: "board", Component: Board });
  eos.sidebarNav({ id: "notes", label: "Sticky notes", icon: <NoteIcon />, view: "board", order: 40 });
}
```

`notes.css`:

```css
.sn { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.sn-add { margin-left: auto; height: 26px; padding: 0 10px; border-radius: var(--r-row); font-size: var(--text-sm); color: var(--fg-mid); background: var(--lg-chip-bg); box-shadow: var(--lg-chip-sh); }
.sn-grid { flex: 1; overflow: auto; padding: 24px 28px; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; align-content: start; }
.sn-empty { color: var(--fg-faint); font-size: var(--text-sm); }
.sn-note { position: relative; min-height: 160px; border-radius: var(--r-card); padding: 14px; box-shadow: 0 8px 24px rgba(0,0,0,.25); }
.sn-note textarea { width: 100%; min-height: 130px; resize: none; border: 0; outline: 0; background: transparent; color: #1a1a1a; font: inherit; font-size: var(--text-sm); line-height: 1.5; }
.sn-del { position: absolute; top: 6px; right: 8px; color: rgba(0,0,0,.45); font-size: 16px; }
.sn-warm .c0 { background: #f6e27a; } .sn-warm .c1 { background: #f7b98b; } .sn-warm .c2 { background: #f49fb6; } .sn-warm .c3 { background: #b9e08f; }
.sn-cool .c0 { background: #9fd3f2; } .sn-cool .c1 { background: #b8b2f2; } .sn-cool .c2 { background: #9fe6d2; } .sn-cool .c3 { background: #d6dde6; }
```

### A side-panel tab

```jsx
export default function activate(eos) {
  const Icon = () => (<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 1" /></svg>);
  function Timer() {
    const [startedAt, setStartedAt] = eos.useStore("startedAt", null);
    // … your UI
    return <div className="pomo">…</div>;
  }
  eos.sidePanelTab({ id: "pomodoro", label: "Pomodoro", icon: <Icon />, Component: Timer, launcher: true });
}
```

## When something's wrong

| `plugin_status` says | Fix |
|---|---|
| `plugin.json is missing` / `not valid JSON` | Write a valid plugin.json in the folder. |
| `id "x" must match the folder name "y"` | Make `id` equal the folder name. |
| `settings.<key>…` / other manifest field errors | Follow the message — the field and the problem are named. |
| `ui.jsx:12:5: …` | A syntax/compile error at that line. |
| `Could not resolve "lodash"` … `a plugin can import only its own files and react…` | Remove the package import; write the code yourself. |
| `the UI entry must export default function activate(eos)` | Add the default export. |
| `window`: `build N failed in the window: …` | A runtime error in your code (often in `activate` or a component); the message says what. |
| `window`: `not loaded in any window yet` | The Eos app is probably closed; it loads when it opens. |
| `state: disabled` | The user turned it off in Settings › Plugins — don't turn it back on yourself; tell them. |

A broken build never takes the old one down: the last good version keeps running until you fix it.

To remove a plugin, delete its folder (only if the user asks). Its stored data and settings stay in Eos in case it comes back.
