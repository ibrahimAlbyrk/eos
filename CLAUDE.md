# CLAUDE.md

## What Eos is

Eos is a macOS app that runs swarms of Claude Code agents. The user talks to an orchestrator. The orchestrator spawns workers, each in its own git worktree. Every tool call an agent makes passes a permission gateway.

The app is one Rust process: the window shell, the core and the agent engine. There is no daemon and no local HTTP server. The React dashboard reaches the core through in-process requests. The iPhone app and paired Macs reach it through gateways. Everything the app knows lives in SQLite and files under `~/.eos`.

The agent engine is `eos-agent-sdk`, a private set of crates pinned to one git commit in `Cargo.toml`. Its code is not in this tree.

Users upgrade from the 0.1.x app, a TypeScript implementation. This app must answer and write exactly what that app did. That constraint shapes most of the rules below.

## How the tree is shaped

- `crates/` is the main cargo workspace. One crate per responsibility, in layers.
- `host/` is a second cargo workspace. It holds the window shell (Tauri on CEF), the `eos` binary, the CEF helper and the update applier. It is separate so the main workspace never builds CEF.
- `app/ui/` is the dashboard, a React app with its own npm package. The app ships its build.
- `fixtures/` is what the 0.1.x app answered and computed, frozen. Tests hold the Rust code to it.
- `ios/`, `relay/` and `update-server/` are the phone client, the relay and the update feed's server. Each is built and deployed on its own and has its own README.
- `xtask/` holds the repository checks, the install tool and the release builder. `scripts/` and `host/scripts/` wrap them.
- `spikes/`, `research/` and `design-variants/` are prototypes and notes. Nothing in the product depends on them.

## Where the rules are written

`ARCHITECTURE.md` is binding for every crate. Read it before any structural change. It holds the layer order, the port conventions, the ordering rules for state, what may be logged and the host rules. When a change needs a rule to change, change that file in the same commit and say why.

`DEVELOPMENT.md` covers the toolchain, the two workspaces, building from source, dev runs and the environment variables.

`docs/adding-a-feature.md` is the path a new feature crate follows.

`fixtures/README.md` explains the recorded wire and the frozen vectors.

`crates/eos-runtime/README.md` and `crates/eos-contracts/README.md` explain the model a feature works in: routes, access rules, events, jobs and wire types.

Every crate's `src/lib.rs` starts with a doc comment that says what the crate is for. Read it before the modules.

## What the tooling enforces

Knowing these saves a failed check later.

- Every workspace crate must be listed in `xtask/src/layers.rs`. A crate may depend only on lower layers. Features never depend on each other.
- Only `eos-engine` may import the agent engine. `eos-auth` may import its two sign-in crates. Nobody else, not even in tests.
- `unsafe` is denied workspace-wide. The only exceptions are the shell's `native` modules and `crates/eos-platform/src/darwin/qos.rs`.
- Tauri and CEF names stay inside `eos-shell`'s private modules. Every web view is created in one file, without a bridge.
- Clippy warnings are errors in the check. `unwrap_used`, `todo` and `dbg_macro` are warnings.
- A route with no access rule makes the router refuse to build.
- The route table in `eos-contracts` is compared with `app/ui/src/api/routes.js`. A new route goes in both.
- The prompt library, the worker definitions and the plugin-authoring skill under `assets/` are hashed in `fixtures/`. Editing one fails a test until its fixture changes too.

## What would break things if done carelessly

**The wire is fixed.** Paths, methods, JSON shapes, status codes, error bodies and stream frames are what the released iOS app and paired Macs read. Never change an existing route or topic. Add a new one beside it, marked `added` in the route table. Where the Rust core differs from the recordings on purpose, list it in `fixtures/wire/rust-differences.toml` with its reason.

**The database file is shared with older versions.** `~/.eos/state.db` must still open in the previous app version. This app's own migrations live in `crates/eos-kit-sqlite/src/migrate/own.rs`. They are append only. They add tables or indexes, never a column on an existing table. An existing migration is never edited.

**User data cannot be regenerated.** `~/.eos` holds the database, policy, config, pages, profile, memories, worker definitions and sign-ins. Nothing in this repository may delete it. A deletion the user may want back goes through the trash port. A new user-data file or folder must be added to `USER_DATA_ENTRIES` in `crates/eos-platform/src/paths.rs`. Otherwise the startup snapshot skips it.

**Only the installed app acts as the user.** A dev run, a test, a replay or a copy of a data folder never reaches the relay, paired computers, the sync vault, the update feed or the user's accounts. The one switch is `crates/eos-app/src/reach.rs`. A dev run also refuses routes that start agents or commands. Those routes are classified in `crates/eos-bridge/src/dev/guard.rs`. A new route that is not a plain read must be classified there.

**Logs never carry content or secrets.** Ids, kinds, counts, durations and paths are fine. Prompts, messages, file contents, tool input and output, tokens, e-mail addresses and names are not. `ARCHITECTURE.md` has the full rule. A test plants secrets in a session and fails when one reaches the log.

**Fixtures change only on purpose.** A fixture changes in the same commit as the behaviour change that needs it. It never changes to make a test pass. `fixtures/private` is never committed.

**Time and ids come from ports.** Domain, service and feature code never reads the clock or makes an id directly. It uses the `Clock` and id ports so tests are deterministic.

**Ordering is explicit.** A database read-modify-write is one closure on the writer thread. An event that announces a write goes through the write job's outbox, so it leaves after commit. Never publish from the caller's thread after the write returned. Never hold a lock across an `.await`.

## Costs and things you cannot undo

- Building the host workspace fetches CEF (about 460 MB) and takes many minutes. The main workspace's checks never need it.
- `eos build` and `cargo xtask install` replace the app in `/Applications` and open it on the user's real data. Do this only when asked.
- `scripts/local-sdk.sh` makes both lockfiles name a local engine checkout. Turn it off before committing.
- The vendored runtime in `host/vendor/` is upstream plus the diffs in `host/patches/`. Change it through a patch, never by editing the vendored copy alone.
- The dashboard's build output (`app/ui/dist`) is git-ignored. A dashboard change reaches the app only after a build.

## How to write here

- Small modules, one responsibility each. No speculative options.
- Comments say why, not what. Docs describe current behaviour, never history.
- One `thiserror` enum per crate. No `anyhow` outside binaries, tests and xtask. No `unwrap` in library code except on an invariant proven on the line above.
- Wire types follow the recorded wire: camelCase, unknown fields ignored, fields written in the recorded order.
- A new feature is one crate, `eos-mod-<name>`, and one line in `crates/eos-app/src/modules.rs`. A capability another feature needs is a trait in `eos-core`, handed in at composition.
- Text files are LF on every platform.

## Testing and verifying changes

This section is intentionally left for the owner to fill in.
