---
name: eos-plugin-authoring
description: Build or change an Eos plugin — a live addition to Eos's own interface (the app you are running in). Use whenever the user asks to add, change or remove something in Eos itself, such as a widget or clock in the chat header, a tab in the left sidebar with its own view (notes, a dashboard, a timer), a tab in the right side panel, or settings for such a thing. Not for Claude Code mods and not for editing the Eos source.
---

# Eos plugins

An Eos plugin is a folder of a few files. Eos builds it and shows it in every open Eos window **the moment you save** — no restart, no install step, no approval. Each later save replaces it in place. The user turns it on/off and changes its settings under Settings › Plugins.

A plugin is judged by how it looks and feels, not only by whether it works. The user expects something that feels designed: clear hierarchy, considered color and type, smooth motion, thoughtful details. Plain, default-looking output is a failed result even when every feature works.

## The loop

1. **Find the folder.** Call `plugin_status` with no id (load the plugin tools with ToolSearch if they aren't loaded). It returns `pluginsDir` and the plugins already there. If the user asks to change an existing plugin, edit that one instead of making a new one.
2. **Design before code.** Read `references/design.md` (in this skill's folder) in full, then write the short design brief it describes. Don't skip this for anything the user will see.
3. **Write the files** with Write/Edit into `<pluginsDir>/<id>/`. The id is the folder name: lowercase letters, digits, `-`.
4. **Check the build.** Call `plugin_status` with the id. It waits for the rebuild and for the app to load it. Fix every `buildError` and every `window` failure, then check again, until `state` is `active` and `window` says the build loaded. If `window` says it's not loaded in any window yet, the Eos app may be closed — say so; the plugin will appear when it opens.
5. **Look at it.** Call `plugin_preview` and read the PNG it returns. Preview the states from your brief by passing sample `store` data (realistic content, an empty state, a stress case). Review each picture against the checklist in `references/design.md`, fix what falls short, and preview again. Stop when it meets the checklist (usually 2–3 rounds), not after the first picture that merely works.
6. **Tell the user** where it is (which surface, e.g. the left sidebar or the chat header), what it does, its shortcuts and its settings.

## Files

A plugin folder holds:

- `plugin.json` — the manifest (required).
- The UI entry: `ui.jsx` (or `ui.tsx`, `ui.js`, `ui.ts`).
- Any `.css` files, imported from the UI entry; they load and unload with the plugin.
- Other `.js`/`.jsx`/`.ts`/`.tsx` modules you import, and assets: an imported `.svg` gives its SVG text, `.png/.jpg/.gif/.webp` give a data URL.

Split a plugin that grows past a couple of hundred lines into modules (components, styles, helpers).

### plugin.json

| Field | Rule |
|---|---|
| `id` | Required. Must equal the folder name. |
| `name` | Required, ≤ 60 chars, sentence case. |
| `description` | ≤ 300 chars: what it does and where it lives. |
| `version` | Semver string. |
| `icon` | Optional inline 24×24 SVG string using `currentColor`, shown in Settings › Plugins. Draw one that fits the plugin. |
| `settings` | Optional; becomes the plugin's page in Settings › Plugins. An object of key → definition. Types: `boolean`; `string` (`placeholder`, `multiline`); `number` (`min`, `max`, `step` — with both min and max it's a slider); `select` (`options: [{value, label}]`). Each has a `title` and always a `default`. Keys: letters, digits, `_ . -`. Add only settings the user would really change. |
| `experimental` | `true` makes it start turned off. Don't use it unless asked. |

### The UI entry

Its default export is a function `activate(eos)`. It runs when the plugin loads; everything it adds through `eos` is removed automatically when the plugin reloads, is turned off or deleted. Components can be defined inside `activate` (so they can use `eos`) or outside it.

Imports: only your own files and `react`, `react/jsx-runtime`, `react-dom`. **No npm packages** — nothing else resolves, and nothing loads from the network (no web fonts, no CDN scripts). Write what you need yourself. JSX works in `.jsx`/`.tsx`.

## The `eos` API

| Call | Adds | Component props |
|---|---|---|
| `eos.headerRight({ id, Component, once?, order? })` | A widget on the right of a chat's header, left of the panel buttons. `once: true` = only in the top-right pane (one per window) — for anything global; without it every split pane gets one (for per-chat things). | `{ worker, live, topRight }` — `worker` is the pane's agent row or null (new chat) |
| `eos.sidebarNav({ id, label, icon, view, order? })` | A row in the left sidebar under New task / Changes / Archive that opens main view `view`. `icon`: a 15×15 SVG element using `currentColor`. Built-in rows use order 10/20/30. | — |
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
| `eos.useStore(key, initial)` | `[value, setValue]` like `useState`, but **kept across restarts** and synced between windows. `setValue(next)` or `setValue(prev => next)`. Values are JSON. Use it for anything the user creates. Writes are saved after a short pause, so calling it on every keystroke is fine. |

`live.workers` (from `{ live }`) is the list of agent rows (`id`, `name`, `state`, `cwd`, …), if a view needs it. In `plugin_preview` it is empty.

Ids you pass (`id`, `view`) are your own — Eos namespaces them per plugin.

### Main view header

A main view starts with Eos's own header row so it lines up with the rest of the app: a `div` with classes `pane-head pane-head--topleft pane-head--topright`, whose first child is an empty `span` with class `pane-head-inset` (`aria-hidden`), then a `div.crumb` holding a `span.cur` with the view's name, then any header controls of yours. Below it, your content in an element that fills the rest (`flex: 1; min-height: 0`) and scrolls itself. The view's root is a column flex container with `flex: 1; min-height: 0`.

## Picking where it goes

| The user says | Use |
|---|---|
| "top right", "in the header", "next to the panel button", a small always-visible indicator | `headerRight` (with `once: true` unless it's about that chat) |
| "a tab in the left sidebar", "next to New task / Archive", a page of its own | `sidebarNav` + `mainView` |
| "in the side panel", "next to Files / Terminal / Changes", a tool beside the chat | `sidePanelTab` (`launcher: true`) |
| "a setting for …" | a `settings` entry in plugin.json, read with `useSetting` |

If it's unclear, pick the closest and say where you put it.

## `plugin_preview`

Draws one surface of the plugin's current build in a hidden window with Eos's real styles and returns `{ path, surface, view, errors, available, … }`; read `path` to see it. It never touches the user's windows or data.

- `surface`: `main`, `panel` or `header` (default: the first the plugin registered). `view`: which mainView / sidePanelTab id.
- `store`: sample values for your `useStore` keys, for this picture only. Keys you leave out show what the user really stored.
- `width` / `height`: try a narrow window or a short one. `waitMs`: how long entrance animations play before the shot (default 700; `0` shows their first frame).
- `errors` lists crashes while drawing. A still can't show motion — check motion by reading your code against the motion rules.

## Rules

- Everything goes inside `<pluginsDir>/<id>/`. Never edit the Eos app's source, `~/.eos` files outside your plugin folder, or Claude Code's settings/mods for this.
- **Prefix every class and CSS custom property** with the plugin's id so nothing collides with Eos or other plugins. Don't restyle Eos's own classes.
- No top-level side effects in the UI entry — start timers, listeners and fetches inside components (`useEffect`, with cleanup) so a reload leaves nothing behind.
- No network calls to the Eos daemon and no `window.__EOS_*`; use `useStore` / `useSetting`.
- One plugin per user request unless they ask to extend an existing one. Don't add `experimental`, permissions or settings nobody asked for.

## When something's wrong

| `plugin_status` / `plugin_preview` says | Fix |
|---|---|
| `plugin.json is missing` / `not valid JSON` | Write a valid plugin.json in the folder. |
| `id "x" must match the folder name "y"` | Make `id` equal the folder name. |
| `settings.<key>…` / other manifest field errors | Follow the message — the field and the problem are named. |
| `ui.jsx:12:5: …` | A syntax/compile error at that line. |
| `Could not resolve "…"` … `a plugin can import only its own files and react…` | Remove the package import; write the code yourself. |
| `the UI entry must export default function activate(eos)` | Add the default export. |
| `window`: `build N failed in the window: …` | A runtime error in your code (often in `activate` or a component); the message says what. |
| `window`: `not loaded in any window yet` | The Eos app is probably closed; it loads when it opens. |
| `state: disabled` | The user turned it off in Settings › Plugins — don't turn it back on yourself; tell them. |
| preview `errors` not empty, or a blank picture | A component crashed or rendered nothing; fix it and preview again. |
| preview: `the Eos app isn't open` | Say so; you can't look at it until the app is open. |

A broken build never takes the old one down: the last good version keeps running until you fix it.

To remove a plugin, delete its folder (only if the user asks). Its stored data and settings stay in Eos in case it comes back.
