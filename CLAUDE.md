# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`Eos` is a macOS app for running Claude Code agents. A persistent orchestrator decomposes a task and spawns workers (through MCP tools), each in its own git worktree; workers may spawn sub-workers and consult peers. A focused chat is one agent with Claude Code's full tool surface. The app is **one Rust program**: a window shell (Tauri 3 on CEF), the core, and the agent engine (`eos-agent-sdk`, a separate repository) in one process — no daemon, no local HTTP server. The React dashboard reaches the core through same-origin requests the shell answers in process; the released iOS app reaches it through a relay, paired Macs over a peer link. State and a full event log live in SQLite (WAL) under `~/.eos` and stream to every client over one event stream.

## Layout

```
Cargo.toml       the main cargo workspace: crates/ (in layers), xtask/ (repo checks, install,
                 publish-update), tools/ (the wire replay), spikes/ (proven library choices)
host/            the host workspace: the shell, the `eos` binary, the CEF helper, the update applier
fixtures/        what the 0.1.x app answered and computed, frozen: the reference the app is held to
assets/          files the app ships as they are (the plugin-authoring skill, pdf.js), and the banners
scripts/         check.sh, replay.sh, link-sdk.sh and other development scripts
app/ui/          the React 18 + Vite dashboard, bundled into the app (its own npm package)
ios/             the iPhone client (SwiftUI, XcodeGen; ios/BUILD.md)
relay/           the relay server for the phone link and the sync vault (Node, deployed on its own)
update-server/   the static update feed's server config and deploy script
docs/            how-tos (adding-a-feature.md, first-rust-release.md, …), PROMPTING.md, release notes
```

Read before changing Rust code: `ARCHITECTURE.md` (binding: layers, ports, errors, state changes, memory, wire types, the host layer) and `docs/adding-a-feature.md` (the steps every feature crate follows). `DEVELOPMENT.md` covers building, the host workspace, dev runs and the shell's bridges; `fixtures/README.md` the recorded wire and the replay; `docs/differences-from-typescript.md` every deliberate difference from the 0.1.x app users upgrade from; `docs/first-rust-release.md` what a release must be to install over 0.1.x.

## Build, test, install

```bash
scripts/link-sdk.sh                       # once per checkout: link the agent engine (DEVELOPMENT.md)
scripts/check.sh                          # fmt, clippy -D warnings, tests, layers, shell rules (never builds CEF)
scripts/replay.sh [--only 31-pages]       # the recorded wire against the composed app, in process
host/scripts/setup.sh                     # once: cmake, ninja, esbuild, the dashboard's node modules and build
host/scripts/check.sh                     # the host workspace: fmt, clippy, dev guard, vendored patches
host/scripts/bundle.sh test               # a test bundle (dev-run guard) → host/.work/bundle/test
python3 host/tests/smoke.py <Eos.app>     # also browser_smoke, artifact_smoke, responsiveness
cd app/ui && npm test && npm run lint && npm run build
cd relay && npm test
cargo xtask install                       # build this checkout and install it as /Applications/Eos.app
```

Single test: `cargo test -p eos-mod-pages --test pages` · `cd app/ui && npx vitest run match`.
Preview a system prompt: `cargo run -p eos-store-files --example preview_prompt -- <orchestrator|worker>`.

**While developing Eos, never install or launch a release build** (`cargo xtask install`, `bundle.sh release`): the installed app is the user's real Eos on the real `~/.eos`, and installing quits it and every agent in it. Verify with the check scripts, the replay and the test bundle. A dev run (`bundle.sh test`/`debug`, `host/scripts/dev.sh`, `host/scripts/launch.sh`) has no default data folder and refuses whatever would act for the user — agents, model calls, commands, other computers, files outside its data copy (`DEVELOPMENT.md`, "The core, and a dev run").

## Rules that hold everywhere

- **The wire does not change.** Paths, methods, JSON shapes, status codes, error bodies and stream frames are the 0.1.x app's; the dashboard, the released iOS app and paired Macs read them. The recordings in `fixtures/wire` are the judge (`replay.sh`); a deliberate difference is listed in `fixtures/wire/rust-differences.toml`. What the dashboard needs beyond them is added beside them (a new route, parameter or topic), never by changing one. The dashboard's route table is `app/ui/src/api/routes.js`, held to the core's by an xtask test.
- **Layers are enforced** (`cargo xtask layers`): `types → domain → core → service → kit → adapter → runtime → feature → app → host`. Features (`eos-mod-*`) never depend on each other: a capability another feature needs is a trait in `eos-core`, handed over in `eos-app` (`crates/eos-app/src/modules.rs`, one line per feature). Only `eos-engine` imports the agent engine (its sign-in crates also `eos-auth`).
- **OS differences live in `eos-platform` and the shell** (`eos-shell`); `unsafe` only in `eos-shell/src/native/` and one marked spot in `eos-platform`. The app is macOS only; Windows users stay on the last 0.1.x release.
- **`~/.eos` is non-regenerable user data** (the manifest: `crates/eos-platform/src/paths.rs`) and keeps the 0.1.x formats, so the previous app can still open it. Never `rm`/`mv` it by hand; template and plugin deletes are soft (`.trash/`). The database opens in place; new migrations add tables or indexes only (`crates/eos-kit-sqlite`); a snapshot goes to `~/.eos/backups` before the first open.
- **Every tool call passes the permission gateway** (`eos-policy`, in process): the worker's permission mode (`default`/`acceptEdits`/`plan`/`bypassPermissions`, inherited from the parent chain), its definition's tool scope, then `policy.yaml`. `AskUserQuestion` and Claude Code's `Workflow` tool are blocked for orchestrators and workers (`eos-contracts` `tool_scope.rs`); an orchestrator asks the user through `mcp__orchestrator__ask_user`. A focused chat gets Claude Code's full surface.
- **System prompts are assembled per spawn** (`eos-prompts`) from the library in `crates/eos-store-files/assets/prompts` (`~/.eos/prompts` overrides it). A fragment's `when` may gate only on session-immutable facts (role, subagent, worktree, worker definition), never on model, effort, permission or git state. The library, the bundled policy and the plugin skill are held to frozen copies in `fixtures`: change one and its fixture together, on purpose.
- **Route access is declared per route** (`eos-runtime` `Access`): `ui_token()` for what only the user's own dashboard may do, `.local_only()` for what never crosses to a paired computer, and the phone's tier. A route without a rule fails the build.

## Features (where each lives)

- **Agents and sessions**: `eos-sessions` (spawn, deliver, interrupt, resume, the state machine), `eos-engine` (sessions on the agent engine; its events → canonical agent events), `eos-mod-agents` / `eos-mod-workers` (routes), `eos-tools` (the MCP tools agents get), `eos-workers` (worker definitions: built-ins, `~/.eos/workers`, a project's `.eos/workers`).
- **Context compaction** (`eos-mod-compaction`): at a worker's idle edge once its context reaches `config.compaction.threshold`, or on `/compact [focus]`, a tool-less summarizer on the agent's own model condenses the conversation and the session continues from the summary; the worker is held meanwhile. The dashboard folds history behind the `compaction_completed` card (`app/ui/src/views/agents/messages/compaction/`).
- **Background jobs** (the job registry in `eos-runtime`, in memory; each feature feeds its own): topic `jobs:change`, routes `/api/jobs*`. UI: `views/jobs/` (header beacon + Jobs tab), `state/jobsStore.js`, `lib/jobs.js`.
- **Workflow runs** (`eos-mod-workflow-runs`, focused chats): live progress on `workflow:progress`, routes `/workers/:id/workflow-runs*`. UI: `views/agents/workflow/`, `state/workflowRunsStore.js`, `lib/workflowRuns.js`.
- **Side question** (`/btw`, `eos-mod-btw`): a read-only question answered from the live conversation without adding to it; `POST /workers/:id/btw`. UI: `views/btw/SideQuestionPanel.jsx`, `state/sideQuestionStore.js`.
- **Conversation-wide lists ≠ transcript window.** The transcript pages lazily and folds at compaction, so a panel listing things from the whole chat (subagents, artifacts) never derives from the loaded window alone: use `useConversationLists` (`state/conversationListsStore.js`: the window's own lists when it holds the whole chat, else the core's summaries `GET /workers/:id/subagents` / `/artifacts`); one subagent's rows come from `useSubagentDetail`. A new conversation-wide list gets its own summary in the core (the subagent-lists table, migration 066).
- **Accounts** (Settings › Accounts; rules `eos-accounts`, stores and sign-in `eos-auth`, the billing rule `eos-domain` `accounts.rs`): signed in → the plan, always; expired → blocked, no silent fallback to an API key; else the key. Only Eos's own sign-ins count: each is a store under `~/.eos/accounts/` (`claude-<loginId>`, indexed by `accounts/logins.json`). A session that hits a plan limit or an expired sign-in moves to the next ready sign-in; with none left an `accounts_exhausted` row offers "Resume at" or "Use API key". Plan usage: `usage:change`.
- **Pages** (`eos-mod-pages`): markdown notes in `~/.eos/pages/<id>.md`, one write path, `pages:change`; a full-body save with a stale `baseRev` is refused (409) and the dashboard merges (`lib/pageMerge.js`); agents use targeted edits (`list_pages`, `read_page`, `create_page`, `append_to_page`, `edit_page`, `set_page_task`). Editor: `views/pages/editor/`.
- **Profile & memory** (`eos-mod-profile`, rendering `eos-profile`): `~/.eos/profile/` (`profile.json`, avatar, `memories/<id>.md`), `profile:change` / `user-memory:change`; agents only suggest (`suggest_memory`, `search_memory`), the user keeps. Profile text enters prompts at spawn. **Dreaming** (`eos-mod-dreams`, off by default, nightly at `03:00`) proposes through the same path. UI: `views/memory/DreamJournal.jsx`, `components/profile/DreamReview.jsx`.
- **Plugins** (Settings › Plugins; `eos-mod-plugins`, builder `eos-plugin-build` over esbuild, files `eos-plugin-files`): a plugin is `~/.eos/plugins/<id>/` (`plugin.json` + optional UI entry), rebuilt on change and loaded by every window without a restart; switches and stored values in `~/.eos/plugin-data/`. Agents learn the API from the skill in `assets/claude-plugin`. Installing (npm, git, folder) is the user's alone: staged in `plugins/.staging`, reviewed, swapped in whole; `plugin-data/installed.json` records the source. Built-in plugins (`eos-contracts` `builtin_plugins.rs`, `app/ui/src/shared/builtin-plugins.ts`) toggle the same way; off, their routes answer 404 `plugin_off` and their tools and prompt fragments are left out of new sessions. UI: `app/ui/src/plugins/`, `slots/`.
- **Sync** (Settings › Sync; engine `eos-sync`, wiring `eos-mod-sync`, vault client `eos-sync-vault`): profile, avatar, memories, pages, templates and worker definitions follow the user to every Mac holding the same sync key (`eos-sync1.<relayUrl>.<secret>`), through an end-to-end encrypted vault on the relay (`relay/vault/`). State under `~/.eos/sync/`.
- **File transfer** (Transfer tab; `send_to_machine` for focused chats; `eos-mod-transfer`, disk endpoint `eos-transfer-fs`): resumable, staged in `<dest>/.eos-incoming/<id>/`, `transfer:change`. UI: `views/transfer/`.
- **Eos ↔ Eos** (`eos-peer`, `eos-mod-peer`): one identity per app under `~/.eos/peer/`; hosting (off by default; port 7402 and a relay room) and controlling paired Macs; `/h/<hostId>/…` is that host's app. The shell shows each host in a view of its own (`eos_bridge::hosts`).
- **Phone** (`eos-mod-remote`, relay connection `eos-relay`): the phone's control frames become router calls made as the phone, under its tier. While remote is armed, system sleep is held on AC power (`caffeinate -s -w`, `eos-platform`).
- **Code-view terminals** (`eos-mod-terminals`; PTYs and a screen mirror equal to xterm.js's snapshot in `eos-pty`): Claude panes report their session and open dialogs through OSC 7777; the phone drives them with keystroke sequences verified against Claude Code's TUI (`keys.rs`).
- **Visual answers** (`eos-genui` types, parsers and catalog; `eos-mod-genui` routes; `eos-genui-media` media, map and geocoding behind an SSRF guard, cache `~/.eos/media-cache`): orchestrators and focused chats get `present`, `present_app`, `find_places`, `current_location`; the dashboard shares the parsers in `app/ui/src/shared/genui/` and renders from `app/ui/src/genui/`. Location comes from the shell's helper `EosLocation.app` (`host/location`).
- **claude.ai Artifacts** (catalog `eos-mod-artifacts` over `eos-auth`'s frame API; views `eos_bridge::artifacts` and `eos-shell`): each Artifact opens in its own side-panel tab, a native view per Claude sign-in, pool of 4. UI: `views/artifacts/`.
- **In-app updates** (`eos-mod-updates`, `eos-update`, applier `host/eos-apply`): only a release build with `Resources/update.json` updates itself, from the signed feed (`update-server/`), checking every 30 min ±20%; a build from source says "Built from source". Publish with `cargo xtask publish-update` (`docs/first-rust-release.md`).
- **Notifications**: the core's `notification:fire` becomes a macOS banner with Eos's sound, only while the window is not focused; a click opens the worker. Dashboard code calls `notify.warning/.error` (`lib/notify.js`); `notify.info` is silent; there are no in-app toasts.

## Dashboard conventions (`app/ui`)

- Desktop conventions come from `<html data-os>` (`lib/platform.js`), what the host offers from ui-config `features` (`state/featuresStore.js`). The shell's bridges (`eosBrowserView`, `eosNotify`, `eosHosts`, `eosArtifacts`, `eosTransfer`, …) are listed in `DEVELOPMENT.md`; a host's view gets only a few.
- **Liquid glass is an accent, not a theme**: floating layers and interactive states only, palette unchanged. `styles/glass.css` (imported last) holds the tokens and the floating-surface recipe: blur + tint on `::before`, rim on `::after` — never `backdrop-filter` on the host (nested glass goes blank), never animate a glass host's `opacity`. The composer and the scroll-to-bottom drop use `components/glass/GlassLayers.jsx` (`lib/liquidGlass.js`). ⌘B toggles the sidebar.
- **Clickable paths**: assistant prose runs through `hooks/usePathChips.js` (`lib/pathLinks.js` finds paths, `lib/pathStat.js` checks them via `/fs/stat`); only existing paths become chips; one delegated hook per transcript (`views/agents/messages/paths/usePathLinks.jsx`). Settings › Code › Files & links (`paths.*`).
- **Side panel**: `+` opens a `newtab:N` launcher (`views/newtab/`); the Changes tab (`views/agents/gitdiff/`) defaults to uncommitted changes, with branch, commit and stash scopes.
- `src/shared/` holds the pure modules the core implements too (visual-answer parsers, artifact ids, attachments, built-in plugin ids). Tests: `npm test` (vitest); lint: `npm run lint` (correctness and React hooks rules).

## Style notes

- Comments only when *why* is non-obvious; docs describe current behaviour only. Rust: one `thiserror` enum per crate, no `unwrap` in library code, no unbounded queue or cache, the `Clock`/`Ids` ports instead of reading the clock or a random source (`ARCHITECTURE.md` §3).
- Code and CLI output in English; user messages may be Turkish. Public repo — no claude.ai session trailer in commits.
