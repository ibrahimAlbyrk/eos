# Architecture

Eos is one Rust application: a window shell (Tauri 3 on CEF), the core, and the agent engine
(`eos-agent-sdk`) in one process. There is no daemon and no local HTTP server. The React
dashboard (`app/ui`) is unchanged; it reaches the core through same-origin requests the shell
answers in-process.

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

- The wire is today's: same paths, methods, JSON shapes, status codes, error bodies, and the same
  event stream frames (`id`, `event`, data; ring + `?since=` / `resync`). The dashboard, the
  released iOS app and paired Macs depend on it. Recorded fixtures (`fixtures/`) are the judge.
- `http://eos.localhost/_shell/…` are the shell's own bridges (window, views, notifications);
  `http://raw.eos.localhost/…` is the raw-content origin. No page gets Tauri IPC.
- The shell tells the bridge who made each request, from what the browser itself knows: the
  view's top-level load, the dashboard document, or a frame inside it. The ui-token is only
  ever handed to the top-level load; the shell bridges answer only the dashboard document.

## 2. Layers and crates

`types → domain → core → service → kit → adapter → runtime → feature → app → host`
(`cargo xtask layers`; a crate depends only on lower layers; every crate is listed there).

| Layer | Crate | Holds |
|---|---|---|
| types | `eos-contracts` | every wire type: ids, route table, request/response bodies, canonical agent events, worker rows, bus topic payloads, error codes. serde + `schemars`. No logic beyond validation. |
| types | `eos-genui` | visual-answer markup / partial-JSON / expression / attribute parsers, catalog, `validate_view`, `catalog_prompt`. Self-contained. |
| domain | `eos-domain` | pure rules (no async, no I/O, no clock reads): billing route, workflow-run reducer, dream ledger, update chunker and manifest, page merge, path rules… |
| core | `eos-core` | ports (traits) for everything outside the process, shared `Clock` / id generation, the errors ports share. |
| service | `eos-sessions`, `eos-policy`, `eos-prompts`, `eos-workers`, `eos-profile`, `eos-accounts` | use-cases several features need: agent session lifecycle, permission decisions, prompt assembly, worker definitions, profile/memory rendering, accounts (plan sign-ins, which of them can run, moving a session to another, sign-ins in flight, plan usage). Only ports, never adapters. |
| kit | `eos-platform` | the one OS seam: paths, credentials, trash, keep-awake, shells, process-tree kill, clone-copy. `cfg(target_os)` is allowed only here and in `eos-shell`. |
| kit | `eos-kit-fs`, `eos-kit-sqlite`, `eos-kit-proc`, `eos-kit-net` | atomic writes and frontmatter; the SQLite writer thread, readers and migration runner; running commands; the guarded HTTP client. |
| adapter | `eos-store-sqlite`, `eos-store-files`, `eos-config`, `eos-git`, `eos-fs`, `eos-watch`, `eos-pty`, `eos-engine`, `eos-auth`, `eos-sync-vault`, `eos-update`, `eos-transfer-fs`, `eos-plugin-build`, `eos-plugin-files`, `eos-genui-media`, `eos-peer`, `eos-relay`, `eos-symbols` | one outside system each, implementing core ports. `eos-engine` is the only crate that imports `eos-agent-sdk` (see "The agent engine" below). |
| runtime | `eos-runtime` | what a feature sees of the running app: `Request` / `Response` / body stream, `Router`, route access rules, `Module` trait, event bus, stream ring, job registry, idle hooks, the ordered executor. |
| feature | `eos-mod-<name>`, `eos-tools` | one user-facing feature each (routes + its own use-cases over ports); the agent tools. Features never depend on each other: a capability another feature needs is a trait in `eos-core`, handed in at composition. |
| app | `eos-app` | the composition root: builds adapters, services and modules, returns the `Router` and the lifecycle handle. The only place that knows every concrete type. |
| host | `eos-bridge`, `eos-shell`, `eos` | request mapping and everything of the shell that needs no window; the Tauri/CEF shell (implements view ports such as `BrowserViews`, `Capture`, `FilePicker`); the binary. In that order: each may use the one before it. `eos-shell` and `eos` live in the `host/` workspace (§5). |
| support | `eos-testkit`, `eos-wire-recorder`, `xtask` | fakes, fixture loading, recording and replay, repo checks. |

## 3. Conventions

**Ports.** Object-safe traits in `eos-core`, taking and returning owned or borrowed plain data;
async methods return a boxed future (`Pin<Box<dyn Future<Output = …> + Send + '_>>`, the SDK's
style), no `async-trait` macro. Generic parameters are for hot paths only; composition uses
`Arc<dyn Port>`. Each port has a fake in `eos-testkit`.

**Errors.** One `thiserror` enum per crate, named `Error`, with variants a caller can act on.
No `anyhow` outside binaries, tests and `xtask`. No `unwrap` / `expect` in library code except on
invariants proven on the line above. Errors that reach the wire map to today's status code and
error body in one place (`eos-runtime`).

**Time and ids.** Never read the clock or generate an id directly in domain, service or feature
code: use the `Clock` and id ports so tests are deterministic.

**State changes.** Today's code relies on Node's single thread. Here:
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
where today's wire omits them. JSON objects keep insertion order, as in JavaScript
(`serde_json` with `preserve_order`, set workspace-wide); write fields in today's order. A type that feeds a hash or signature documents its exact byte
format and has cross-implementation vectors.

**Data on disk** (`~/.eos`) keeps its formats. The database opens in place: the 64 migrations
today's code knows are embedded verbatim under their ids; other ids found in the table are ignored
(a real file records 67 rows: two migrations older builds ran, and the vacuum marker); new migrations
add tables, never columns to existing ones, so the previous app version can still open the file.
Snapshot before the first open with a clone copy.

**Proven choices** (from the phase-0 spikes; do not re-decide without evidence): `rusqlite`
bundled; `regress` for user-supplied JavaScript regexes, matching over UTF-16 code units;
`serde_json` with `float_roundtrip`, numbers that feed a hash printed with `ryu-js`;
`serde_norway` or `serde_yaml_ng` for YAML (no merge keys); `rustls` + `h2` for peers with the
existing identity files; `portable-pty` + `vt100` for terminals; the update chunker is the exact
port in `spikes/data`.

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

**Tests.** Port the behaviour the TypeScript tests pin, not their structure. Unit tests beside
the code; cross-crate scenarios in the higher crate's `tests/`. Anything that must equal today's
output is checked against a recorded fixture or a vector, never against a hand-written
expectation of what TypeScript "probably" does.

**Style.** Small modules, one responsibility each; no speculative options; comments only where
the why is not obvious; docs describe current behaviour. `scripts/check.sh` green on every merge.

## 4. Where the TypeScript lives

| TypeScript | Rust |
|---|---|
| `contracts/src` (minus `genui`) | `eos-contracts` |
| `contracts/src/genui` | `eos-genui` |
| `core/src/domain` | `eos-domain` |
| `core/src/ports` | `eos-core` |
| `core/src/use-cases`, `core/src/services` | the service crate or the feature crate that owns the behaviour |
| `manager/services/accounts`, `UsageService`, `PlanResumeService` | `eos-accounts` (the rules), `eos-auth` (stores, sign-in flows, the usage endpoint) |
| `infra/src/auth`, `infra/src/usage` | `eos-auth` |
| `infra/src/<area>` | the adapter or kit for that area (`infra/src/filesystem` → `eos-fs` for the user's files and desktop, `eos-watch` for the watchers) |
| `manager/sse`, `manager/routes` plumbing, `manager/middleware`, `manager/services/jobs`, `IdleHooks` | `eos-runtime` |
| `manager/modules/<feature>`, `manager/routes/<feature>` | `eos-mod-<feature>` |
| `manager/tools` | `eos-tools` |
| `manager/container.ts`, `manager/daemon.ts` | `eos-app` |
| `manager/backends/sdk` | `eos-engine` |
| `manager/peer`, `manager/remote` | `eos-peer`, `eos-relay` + their feature crates |
| `app/src` (Electron main, preload) | `eos-shell` |

Not ported: `gateway/`, `spawner/`, the stdio MCP servers, the launchd agent, the runtime CLI,
the Codex and Gemini lanes.

## 5. The host layer

Two cargo workspaces. `rust/` holds every crate except the two that need Tauri and CEF;
`rust/host/` holds `eos-shell`, the `eos` binary and the CEF helper, with its own lockfile,
build cache and `scripts/check.sh`, and uses the main workspace's crates by path. The reason
is cost: `scripts/check.sh` runs many times an hour and must never build CEF.
`cargo xtask layers` and `cargo xtask shell` read both workspaces without building either.

- **`eos-bridge` is the shell without a window** and lives in the main workspace: the
  transport (`Req`, `Head`, `Sink`, `Body`, `Service`), the URL space, the token rule, the
  shell bridges behind the `ShellHost` trait, the browser panel's geometry, the event stream
  to the page, the storage carry-over, single instance, window state. It has no Tauri or CEF
  type and is tested without a window. What it needs from the core is the `Core` trait
  (`ui_token`, `call(plane, req, sink)`), implemented over `eos-runtime`'s `Router` by
  `RouterCore`: the caller comes from `eos-app`'s `callers().classify`, bodies stream at the
  reader's pace, a dropped request cancels its handler or stream, and every request is
  answered. During the port the `dev-proxy` feature sends the routes the router does not
  declare to an isolated Node daemon (and keeps the event stream there until its events
  come from Rust); it is never part of a release, where an undeclared route is the
  router's 404.
- **`eos-shell` is the only crate that names Tauri or CEF**, and only in its private modules:
  its public API is plain data, the ports of `eos-core::shell` and the `Hooks` the app passes
  in (`core`, `started`, `woke`, `open_url`, `shutdown`).
- **Every view is created without a bridge**, in one function (`views/create.rs`), the
  dashboard included. No page has `window.ipc`, `__TAURI_INTERNALS__` or a Tauri script; no
  Tauri command, event or scheme protocol is registered. Pages reach Rust only through the
  in-process handler of the app's own origin; a bridge is a route under `/_shell/` that
  requires the ui-token and a request made by the dashboard document. Shell → page is one
  event stream. `cargo xtask shell` fails the check when any of this is broken.
- **`eos-apply` is a program of its own** (`host/eos-apply`, shipped as
  `Contents/MacOS/eos-apply`): the update applier. It runs while the app is closed, so it
  links no crate of the app, no Tauri and no CEF — `serde_json` only. It swaps the staged
  bundle in and puts the old one back unless the new app writes `boot-ok` in time
  (`docs/first-rust-release.md`).
- **`unsafe`** only in `eos-shell/src/native/` (CEF's raw read buffer and callbacks, AppKit,
  notifications), each use with its reason. Also checked by `cargo xtask shell`.
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
- **Automated runs never type into a page and never drive the dashboard.** They restore a
  layout through the storage carry-over, observe the shell's status (`Eos --status`) and
  send DevTools calls only to views they created. The dev proxy refuses every write that
  could start an agent, without a switch (`eos-bridge/src/dev/guard.rs`).
