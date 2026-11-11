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

## 2. Layers and crates

`types → domain → core → service → kit → adapter → runtime → feature → app → host`
(`cargo xtask layers`; a crate depends only on lower layers; every crate is listed there).

| Layer | Crate | Holds |
|---|---|---|
| types | `eos-contracts` | every wire type: ids, route table, request/response bodies, canonical agent events, worker rows, bus topic payloads, error codes. serde + `schemars`. No logic beyond validation. |
| types | `eos-genui` | visual-answer markup / partial-JSON / expression / attribute parsers, catalog, `validate_view`, `catalog_prompt`. Self-contained. |
| domain | `eos-domain` | pure rules (no async, no I/O, no clock reads): billing route, workflow-run reducer, dream ledger, update chunker and manifest, page merge, path rules… |
| core | `eos-core` | ports (traits) for everything outside the process, shared `Clock` / id generation, the errors ports share. |
| service | `eos-sessions`, `eos-policy`, `eos-prompts`, `eos-workers`, `eos-profile` | use-cases several features need: agent session lifecycle, permission decisions, prompt assembly, worker definitions, profile/memory rendering. Only ports, never adapters. |
| kit | `eos-platform` | the one OS seam: paths, credentials, trash, keep-awake, shells, process-tree kill, clone-copy. `cfg(target_os)` is allowed only here and in `eos-shell`. |
| kit | `eos-kit-fs`, `eos-kit-sqlite`, `eos-kit-proc`, `eos-kit-net` | atomic writes and frontmatter; the SQLite writer thread, readers and migration runner; running commands; the guarded HTTP client. |
| adapter | `eos-store-sqlite`, `eos-store-files`, `eos-config`, `eos-git`, `eos-watch`, `eos-pty`, `eos-engine`, `eos-accounts`, `eos-sync-vault`, `eos-update`, `eos-transfer-fs`, `eos-plugin-build`, `eos-genui-media`, `eos-peer`, `eos-relay`, `eos-symbols` | one outside system each, implementing core ports. `eos-engine` is the only crate that imports `eos-agent-sdk`. |
| runtime | `eos-runtime` | what a feature sees of the running app: `Request` / `Response` / body stream, `Router`, route access rules, `Module` trait, event bus, stream ring, job registry, idle hooks, the ordered executor. |
| feature | `eos-mod-<name>`, `eos-tools` | one user-facing feature each (routes + its own use-cases over ports); the agent tools. Features never depend on each other: a capability another feature needs is a trait in `eos-core`, handed in at composition. |
| app | `eos-app` | the composition root: builds adapters, services and modules, returns the `Router` and the lifecycle handle. The only place that knows every concrete type. |
| host | `eos-bridge`, `eos-shell`, `eos` | request mapping, the Tauri/CEF shell (implements view ports such as `BrowserViews`, `Capture`, `Notifier`), the binary. |
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
  executor in `eos-runtime`. A handler never holds a lock across an `.await`.

**Memory.** No unbounded queue, channel or cache: each has a stated bound and a policy when
full. Event payloads are serialized once and shared (`Bytes`, `Arc<str>`). Per-session state is
dropped when the session ends; a test proves it where it matters.

**Panics.** The release profile unwinds. Every agent task and every request runs behind a catch
boundary in `eos-runtime` / `eos-engine`; a panic fails that task or request and is logged.

**Wire types.** `#[serde(rename_all = "camelCase")]` unless the recorded wire says otherwise;
unknown fields are ignored on input (clients may be newer); optional fields are omitted exactly
where today's wire omits them. A type that feeds a hash or signature documents its exact byte
format and has cross-implementation vectors.

**Data on disk** (`~/.eos`) keeps its formats. The database opens in place: the 67 existing
migration ids are embedded verbatim; unknown ids found in the table are ignored; new migrations
add tables, never columns to existing ones, so the previous app version can still open the file.
Snapshot before the first open with a clone copy.

**Proven choices** (from the phase-0 spikes; do not re-decide without evidence): `rusqlite`
bundled; `regress` for user-supplied JavaScript regexes, matching over UTF-16 code units;
`serde_json` with `float_roundtrip`, numbers that feed a hash printed with `ryu-js`;
`serde_norway` or `serde_yaml_ng` for YAML (no merge keys); `rustls` + `h2` for peers with the
existing identity files; `portable-pty` + `vt100` for terminals; the update chunker is the exact
port in `spikes/data`.

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
| `infra/src/<area>` | the adapter or kit for that area |
| `manager/sse`, `manager/routes` plumbing, `manager/middleware`, `manager/services/jobs`, `IdleHooks` | `eos-runtime` |
| `manager/modules/<feature>`, `manager/routes/<feature>` | `eos-mod-<feature>` |
| `manager/tools` | `eos-tools` |
| `manager/container.ts`, `manager/daemon.ts` | `eos-app` |
| `manager/backends/sdk` | `eos-engine` |
| `manager/peer`, `manager/remote` | `eos-peer`, `eos-relay` + their feature crates |
| `app/src` (Electron main, preload) | `eos-shell` |

Not ported: `gateway/`, `spawner/`, the stdio MCP servers, the launchd agent, the runtime CLI,
the Codex and Gemini lanes.
