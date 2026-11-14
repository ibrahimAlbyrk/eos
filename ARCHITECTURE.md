# Architecture

Eos is one Rust application: a window shell (Tauri 3 on CEF), the core, and the agent engine
(`eos-agent-sdk`) in one process. There is no daemon and no local HTTP server. The React
dashboard (`app/ui`) reaches the core through same-origin requests the shell answers
in-process.

This file is binding for every crate. Change it in the same commit as the code that needs the
change, and say why in the commit message.

## 1. Request path

```
dashboard (React)  ──fetch / EventSource──▶  http://eos.localhost/_core/…
                                             eos-shell: CEF scheme handler (no socket)
                                             eos-bridge: shell request ⇄ runtime request
phone (relay) ─┐                             eos-runtime: Router ─▶ feature route handler
paired Mac ────┴── gateways call the Router directly
```

- The wire is fixed: the 0.1.x app's paths, methods, JSON shapes, status codes, error bodies and
  event stream frames (`id`, `event`, data; ring + `?since=` / `resync`). The dashboard, the
  released iOS app and paired Macs depend on it. Recorded fixtures (`fixtures/`) are the judge.
- `http://eos.localhost/_shell/…` are the shell's own bridges (window, views, notifications);
  `http://raw.eos.localhost/…` is the raw-content origin. No page gets Tauri IPC.
- The shell tells the bridge who made each request, from what the browser itself knows: the
  view's top-level load, the dashboard document, or a frame inside it. The ui-token is only
  ever handed to the top-level load; the shell bridges answer only the dashboard document.
- A view of a paired computer has a door of its own on its own request context
  (`eos_bridge::hosts`): it reaches only `/h/<id>/…`, every request there carries that view's
  token (the core sees that host's user, nobody else), and its document gets only the machine
  switcher and, when it runs this computer's own dashboard, the transfer calls.

## 2. Layers and crates

`types → domain → core → service → kit → adapter → runtime → feature → app → host`
(`cargo xtask layers`; a crate depends only on lower layers; every crate is listed there).

| Layer | Crate | Holds |
|---|---|---|
| types | `eos-contracts` | every wire type: ids, route table, request/response bodies, canonical agent events, worker rows, bus topic payloads, error codes. serde + `schemars`. No logic beyond validation. |
| types | `eos-genui` | visual-answer markup / partial-JSON / expression / attribute parsers, catalog, `validate_view`, `catalog_prompt`. Self-contained. |
| domain | `eos-domain` | pure rules (no async, no I/O, no clock reads): billing route, workflow-run reducer, dream ledger, update chunker and manifest, page merge, path rules… |
| core | `eos-core` | ports (traits) for everything outside the process, shared `Clock` / id generation, the errors ports share. |
| service | `eos-sessions`, `eos-policy`, `eos-prompts`, `eos-workers`, `eos-profile`, `eos-accounts`, `eos-sync` | use-cases several features need: agent session lifecycle, permission decisions, prompt assembly, worker definitions, profile/memory rendering, accounts (plan sign-ins, which of them can run, moving a session to another, sign-ins in flight, plan usage), the sync engine (one pass against the vault over ports). Only ports, never adapters. |
| kit | `eos-platform` | the one OS seam: paths, credentials, trash, keep-awake, shells, process-tree kill, clone-copy. `cfg(target_os)` is allowed only here and in `eos-shell`. |
| kit | `eos-kit-fs`, `eos-kit-sqlite`, `eos-kit-proc`, `eos-kit-net` | atomic writes and frontmatter; the SQLite writer thread, readers and migration runner; running commands; the guarded HTTP client. |
| adapter | `eos-store-sqlite`, `eos-store-files`, `eos-config`, `eos-git`, `eos-fs`, `eos-watch`, `eos-pty`, `eos-engine`, `eos-auth`, `eos-sync-vault`, `eos-update`, `eos-transfer-fs`, `eos-plugin-build`, `eos-plugin-files`, `eos-genui-media`, `eos-peer`, `eos-relay`, `eos-symbols` | one outside system each, implementing core ports. `eos-engine` is the only crate that imports `eos-agent-sdk` (see "The agent engine" below). |
| runtime | `eos-runtime` | what a feature sees of the running app: `Request` / `Response` / body stream, `Router`, route access rules, `Module` trait, event bus, stream ring, job registry, idle hooks, the ordered executor. |
| feature | `eos-mod-<name>`, `eos-tools` | one user-facing feature each (routes + its own use-cases over ports); the agent tools. Features never depend on each other: a capability another feature needs is a trait in `eos-core`, handed in at composition. |
| app | `eos-app` | the composition root: builds adapters, services and modules, returns the `Router` and the lifecycle handle. The only place that knows every concrete type. |
| host | `eos-bridge`, `eos-shell`, `eos` | request mapping and everything of the shell that needs no window; the Tauri/CEF shell (implements view ports such as `BrowserViews`, `Capture`, `FilePicker`); the binary. In that order: each may use the one before it. `eos-shell` and `eos` live in the `host/` workspace (§5). |
| support | `eos-testkit`, `eos-wire-recorder`, `xtask` | fakes, fixture loading, replay of the recorded wire, repo checks. |

## 3. Conventions

**Ports.** Object-safe traits in `eos-core`, taking and returning owned or borrowed plain data;
async methods return a boxed future (`Pin<Box<dyn Future<Output = …> + Send + '_>>`, the SDK's
style), no `async-trait` macro. Generic parameters are for hot paths only; composition uses
`Arc<dyn Port>`. Each port has a fake in `eos-testkit`.

**Errors.** One `thiserror` enum per crate, named `Error`, with variants a caller can act on.
No `anyhow` outside binaries, tests and `xtask`. No `unwrap` / `expect` in library code except on
invariants proven on the line above. Errors that reach the wire map to the recorded status code and
error body in one place (`eos-runtime`).

**Time and ids.** Never read the clock or generate an id directly in domain, service or feature
code: use the `Clock` and id ports so tests are deterministic.

**State changes.** Nothing gets ordering for free from a single thread:
- every database read-modify-write is one closure on the writer thread (`eos-kit-sqlite`);
  repositories are synchronous and run inside it; readers use read-only connections;
- every in-memory state transition that must be ordered with bus delivery runs on the ordered
  executor in `eos-runtime`. A handler never holds a lock across an `.await`;
- an event that announces a database write is published in commit order: the write job hands
  its events to an after-commit step that runs on the writer thread and only posts them to the
  ordered executor (it never blocks on it). Nothing publishes "row written" from the caller's
  own thread after the write returns.

**Memory.** No unbounded queue, channel or cache: each has a stated bound and a policy when
full. Event payloads are serialized once and shared (`Bytes`, `Arc<str>`). Per-session state is
dropped when the session ends; a test proves it where it matters.

**Panics.** The release profile unwinds. Every agent task and every request runs behind a catch
boundary in `eos-runtime` / `eos-engine`; a panic fails that task or request and is logged.

**Wire types.** `#[serde(rename_all = "camelCase")]` unless the recorded wire says otherwise;
unknown fields are ignored on input (clients may be newer); optional fields are omitted exactly
where the recorded wire omits them. JSON objects keep insertion order, as in JavaScript
(`serde_json` with `preserve_order`, set workspace-wide); write fields in the recorded order. A type that feeds a hash or signature documents its exact byte
format and has cross-implementation vectors.

**Data on disk** (`~/.eos`) keeps its formats. The database opens in place: the 64 migrations
of the 0.1.x app are embedded verbatim under their ids; other ids found in the table are ignored
(a real file records 67 rows: two migrations older builds ran, and the vacuum marker). This app's
own migrations follow them (`eos-kit-sqlite/src/migrate/own.rs`, from 065) and add tables or
indexes, never columns to existing ones, so the previous app version can still open the file.
Snapshot before the first open with a clone copy.

**Proven choices** (from the phase-0 spikes; do not re-decide without evidence): `rusqlite`
bundled; `regress` for user-supplied JavaScript regexes, matching over UTF-16 code units;
`serde_json` with `float_roundtrip`, numbers that feed a hash printed with `ryu-js`;
`serde_norway` or `serde_yaml_ng` for YAML (no merge keys); `rustls` + `h2` for peers with the
existing identity files; `portable-pty` for terminals, with our own screen mirror (a port of
xterm.js's buffer and serializer in `eos-pty`: `vt100` and `alacritty_terminal` cannot give the recorded
snapshot text, which clients replay); the update chunker is the exact port in `spikes/data`.

**The agent engine.** Its crates (`eos-agent-*`, linked at `vendor/eos-agent-sdk`) are visible to
two crates, and `cargo xtask layers` fails any other dependency on them, dev-dependencies included:
- `eos-engine` may use any of them: it is the one crate that runs agents and the only one that
  imports `eos-agent-sdk`;
- `eos-auth` may use `eos-agent-anthropic` and `eos-agent-openai`, the provider sign-in crates, and
  nothing else: a Claude or ChatGPT store is read, renewed and signed in by the engine's own code,
  under the store's refresh lock, so a token the app reads for itself (usage, artifacts) is renewed
  exactly as an agent's request renews it.

No engine type crosses a port. A session's credential is plain data
(`eos_core::accounts::SessionCredential`: a store folder, an API key); `eos-engine` and `eos-auth`
each build the engine's object from it, and both go through the same store lock.

**Tests.** Unit tests beside the code; cross-crate scenarios in the higher crate's `tests/`.
Anything that must equal what the 0.1.x app answered or wrote is checked against a recorded
fixture or a frozen vector (`fixtures/README.md`), never against a hand-written expectation.

**Style.** Small modules, one responsibility each; no speculative options; comments only where
the why is not obvious; docs describe current behaviour. `scripts/check.sh` green on every merge.

## 4. What the app does not have

A permission gateway or PTY spawner of its own (the gateway is `eos-policy`, called in process),
stdio MCP servers, a launchd agent, a command-line client, the Codex and Gemini lanes.

## 5. The host layer

Two cargo workspaces. The repository root holds every crate except the two that need Tauri and CEF;
`host/` holds `eos-shell`, the `eos` binary and the CEF helper, with its own lockfile,
build cache and `scripts/check.sh`, and uses the main workspace's crates by path. The reason
is cost: `scripts/check.sh` runs many times an hour and must never build CEF.
`cargo xtask layers` and `cargo xtask shell` read both workspaces without building either.

- **The dashboard changes for speed, the wire does not.** `app/ui` may be changed to make
  it faster (caching, asking less often, rendering less). Every existing route and stream
  topic answers exactly as before — the iOS app and paired Macs read the same answers —
  and what the dashboard needs beyond them is added beside them (a new route, query
  parameter or topic), never by changing an existing one.

- **`eos-bridge` is the shell without a window** and lives in the main workspace: the
  transport (`Req`, `Head`, `Sink`, `Body`, `Service`), the URL space, the token rule, the
  shell bridges behind the `ShellHost` trait, the browser panel's geometry, the event stream
  to the page, the storage carry-over, single instance, window state. It has no Tauri or CEF
  type and is tested without a window. What it needs from the core is the `Core` trait
  (`ui_token`, `call(plane, req, sink)`), implemented over `eos-runtime`'s `Router` by
  `RouterCore`: the caller comes from `eos-app`'s `callers().classify`, bodies stream at the
  reader's pace, a dropped request cancels its handler or stream, and every request is
  answered; a route the router does not declare is its 404. A development or test run (the
  `dev-run` feature, never part of a release) puts the dev guard in front of it
  (`eos_bridge::dev::Guarded`).
- **The core has threads of its own.** It runs on `eos_app::runtime()`: one async worker
  per core the system gives the process (`available_parallelism`), never fewer than 2 nor
  more than 8, with the blocking pool's bound stated beside them (`eos-app/src/threads.rs`).
  Nothing that blocks a thread may run on an async worker: processes start on the blocking
  pool and with `posix_spawn` (`eos-kit-proc` finds the program on the child's `PATH`, so
  std never forks the app, which has Chromium in it), SQLite has its own reader and writer
  threads, the sign-in's Keychain item is read and written through `spawn_blocking`, and
  the clock is read in process (`eos-platform`), never from a program.
  Every thread of the core (async workers, blocking pool, SQLite writer and readers, the
  ordered lane) runs at macOS's user-initiated class (`eos_platform::set_thread_class`):
  at the default class it lost the CPU to Chromium's busy threads in every burst. Long work
  nobody waits on (unpacking and hashing an update) lowers its own thread to utility for its
  duration (`in_thread_class`). Processes the core starts keep the default class.
  The shell keeps a runtime of two workers for the window's bridges, so a busy core never
  delays them. `host/tests/responsiveness.py` holds this to a budget.
- **`eos-shell` is the only crate that names Tauri or CEF**, and only in its private modules:
  its public API is plain data, the ports of `eos-core::shell` and the `Hooks` the app passes
  in (`core`, `started`, `woke`, `open_url`, `shutdown`).
- **Every view is created without a bridge**, in one function (`views/create.rs`), the
  dashboard included. No page has `window.ipc`, `__TAURI_INTERNALS__` or a Tauri script; no
  Tauri command, event or scheme protocol is registered. Pages reach Rust only through the
  in-process handler of the app's own origin; a bridge is a route under `/_shell/` that
  requires the ui-token and a request made by the dashboard document (a host's view: its own
  token and document, on its own door). Shell → page is one event stream per page. `cargo xtask shell` fails the check when any of this is broken.
  A view's profile is loaded before the view (`views/profiles.rs`): the runtime spins the
  UI thread on CEF's loop until the view's profile is ready, so a profile still being read
  from disk froze the whole window.
- **`eos-apply` is a program of its own** (`host/eos-apply`, shipped as
  `Contents/MacOS/eos-apply`): the update applier. It runs while the app is closed, so it
  links no crate of the app, no Tauri and no CEF — `serde_json` only. It swaps the staged
  bundle in and puts the old one back unless the new app writes `boot-ok` in time
  (`docs/first-rust-release.md`).
- **`unsafe`** only in `eos-shell/src/native/` (CEF's raw read buffer and callbacks, AppKit,
  notifications), each use with its reason. Also checked by `cargo xtask shell`. The one
  exception in the main workspace is `eos-platform/src/darwin/qos.rs`: two pthread calls
  that set and read the calling thread's scheduling class, behind a safe function.
- **The runtime is vendored with patches kept as diffs** (`host/patches/`, each with its
  reason); the helper executable is built from this repo. `host/scripts/check-patches.sh`
  proves the vendored code is upstream plus those diffs. No binary is swapped after a build.
- **Pages stay off the local network; the user does not.** Every profile has a proxy script
  (`eos-bridge/src/lan_guard.rs`) that refuses a LAN address, a `.local` name or a name that
  resolves into the LAN before DNS and before connect; WebRTC may not use UDP outside a
  proxy; device discovery features are off. Otherwise macOS asks the user to let Eos find
  devices on the local network because of a page. A view the user sends to the local network
  may reach it: the core calls `BrowserViews::allow_local_network` before that navigation,
  and never for where a page takes itself (a popup, a redirect). The opening ends when the
  view leaves the local network. The script carries the system's proxy settings.
- **Automated runs never type into a page.** They restore a layout through the storage
  carry-over, observe the shell's status (`Eos --status`) and send DevTools calls only to
  views they created. The one run that drives the dashboard, `tests/responsiveness.py`,
  only clicks, with trusted mouse events through the dev script's `click` step, which
  refuses a control that takes text, submits a form or reads as sending, running,
  approving or deleting; there is no keyboard step. A dev run works on a copy of real data
  and refuses whatever would act for the user from it (an agent, a model call, a command,
  another computer, files outside the data folder) before the router sees it
  (`eos-bridge/src/dev/guard.rs`); a test run that is killed leaves no process behind
  (`host/tests/guard.py`).
