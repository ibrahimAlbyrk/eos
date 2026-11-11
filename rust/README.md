# Eos in Rust

The Rust implementation of Eos: one application that holds the window shell, the core and the agent
engine. It is built beside the TypeScript backend and replaces it in one release.

## Layout

```
crates/    one crate per responsibility, in layers (see xtask/src/layers.rs)
host/      the window shell (Tauri 3 + CEF), the `eos` binary, the CEF helper: a workspace of its own
tools/     dev tooling: wire-recorder (records and replays what the daemon answers);
           *-vectors (what today's TypeScript computes, for the corpora under fixtures/)
xtask/     repo checks (`cargo xtask layers`, `cargo xtask shell`)
scripts/   link-sdk.sh: link the agent engine's checkout (run once per checkout, see "The agent engine");
           check.sh: everything CI runs for the main workspace; wire.sh: record the wire fixtures from
           today's daemon; replay.sh: replay them against the Rust core, in process
fixtures/  recorded responses and TypeScript-made vectors the Rust code must reproduce,
           see fixtures/README.md
           (fixtures/private is never committed)
docs/      how-tos: adding-a-feature.md is the path every feature crate follows
```

## Rules

- A crate depends only on lower layers; `cargo xtask layers` enforces it and every crate must be listed there.
- `unsafe` is denied workspace-wide.
- OS differences live only in the platform kit and the shell.
- The agent engine (`eos-agent-sdk`) is imported by one adapter crate only.

## Check

```bash
scripts/check.sh         # fmt, clippy -D warnings, tests, layers, shell rules; never builds Tauri or CEF
host/scripts/check.sh    # the host workspace: fmt, clippy, the bridge's dev proxy, patches, the same repo guards
```

## The agent engine

Agent sessions run on `eos-agent-sdk`, a separate repository linked in as path dependencies
(`eos-agent-sdk`, `eos-agent-core`, … in `Cargo.toml`). Nothing machine-specific is committed:
`scripts/link-sdk.sh` creates the git-ignored link `vendor/eos-agent-sdk` to a checkout of it
(`$EOS_AGENT_SDK` when set, else the folder `eos-agent-sdk` beside this repository's main checkout,
which is the same place from every worktree), and `SDK_REV` names the engine commit this tree needs.
`scripts/check.sh` starts with `scripts/link-sdk.sh --check`, which fails with what to do when the
link is missing or the linked checkout does not contain that commit. To work on the engine and Eos
together, point `EOS_AGENT_SDK` at your engine worktree, run the script again, and update `SDK_REV`
once the engine change is merged. Only `eos-engine` (sessions) and `eos-auth` (sign-in) depend on
the engine's crates.

## Host workspace

`host/` holds the window shell (Tauri 3 on CEF), the `eos` binary and the CEF helper. It is a
cargo workspace of its own so that `scripts/check.sh` never has to build Tauri or CEF; it uses
the main workspace's crates by path. Binding rules: `ARCHITECTURE.md` §5. Paths below are
relative to `host/`.

```
eos-shell/     the only crate that sees Tauri or CEF types
eos/           the binary: options from the environment, the app's hooks
cef-helper/    the executable of the five CEF helper apps (renderer, GPU, …)
vendor/        tauri-runtime-cef 3.0.0-alpha.7 with our patches applied
patches/       those patches as diffs (scripts/check-patches.sh proves vendor = upstream + patches)
bundle/        Info.plist templates, entitlements
scripts/       env, check, bundle, sign, dev, try, the isolated daemon
tests/         smoke run, local-network probe, proxy-script test
.work/         build caches (not in git): cargo registry, CEF (~460 MB), target, bundles
```

The portable half of the shell lives in the main workspace and is tested there without a
window: `crates/eos-bridge` (transport, URL space, token rule, bridges, panel geometry, storage
carry-over, single instance, window state, the dev proxy) and `crates/eos-core` (`shell`: the
view ports the shell implements).

### Build, check, run

Needs: Xcode command line tools, `ninja` and `cmake` on PATH (or a cmake under
`.work/tools/`), Node for the dashboard build (`app/ui`: `npm ci && npm run build`).

```bash
scripts/check.sh                  # fmt, clippy, the bridge with its dev proxy, patches, repo guards
scripts/dev.sh                    # debug bundle against the isolated Node daemon
scripts/bundle.sh release         # Eos.app with the five helper apps → .work/bundle/release/
scripts/sign.sh <Eos.app>         # local Developer ID signature, --timestamp=none, nothing sent anywhere
python3 tests/smoke.py <Eos.app>  # launches quietly, 34 checks, quits (never types into a page)
python3 tests/lan_probe.py <Eos.app>
scripts/try.sh                    # for a person: see the header of the script
```

`scripts/bundle.sh` assembles the bundle itself (binary, dashboard, framework, helper apps);
the Tauri CLI is not used, because it compiles its own copy of the helper and offers no way to
build ours. Most routes are not ported yet, so a bundle is built with the `dev-proxy` feature
by default (`EOS_BUNDLE_FEATURES=` for one without: a route Rust does not declare is a 404).

### The core, and the dev proxy during the transition

The binary builds `eos-app` from the data folder named by `EOS_HOME` and the shell reaches its
router in process (`eos_bridge::RouterCore`): each page request becomes a runtime request
tagged with its caller (`eos-app`'s `callers().classify` on the ui-token; the raw origin is
never the dashboard), whole bodies are sent at once and streams chunk by chunk at the
reader's pace, a route's own 206 passes through, a request the page drops cancels the handler
or its stream, and a request is always answered, also when its task dies. There is no default
for `EOS_HOME` yet: without it the Rust core does not start, so nothing opens the real
`~/.eos` by accident.

While routes are still being ported, a bundle is built with the `dev-proxy` feature: a request
goes to the Rust router when it declares that route and to an **isolated** Node daemon
otherwise (`eos_bridge::dev::Hybrid`). Without the feature an undeclared route answers as the
router answers it (404). Which side served a request is logged at debug level under
`eos::bridge` (`EOS_LOG=eos::bridge=debug`, the launcher's default), and `Eos --status` counts
both sides and lists the routes Rust has served.

One exception: the event stream (`/stream`, `/stream/focus`). The Rust runtime declares it
already, but the events the dashboard lives on still come from the daemon, so the daemon keeps
those two routes until the features that produce the events are in Rust
(`EOS_DEV_RUST_STREAM=1` sends them to Rust; the smoke run does that once).

The daemon (`scripts/daemon.sh`) runs on a copy of the data folder, ports 7490/7491, no
launchd, `CLAUDE_CONFIG_DIR` at an empty folder. The proxy forwards reads and refuses every
write except the browser panel's own routes, the file and git watches and the stream's focus
(`crates/eos-bridge/src/dev/guard.rs`); there is no switch to turn that off. The Rust core
opens the same isolated folder, so both sides share one ui-token and one set of data. The
daemon's browser verbs are served from the shell's views over the `BrowserViews` port, its
notifications become native banners.

### What the dashboard gets (bridge inventory)

Everything is a same-origin route under `/_shell/` carrying the ui-token, plus one event
stream. Members of the Electron preload and of main's calls into the page:

| Surface | Now | Later |
|---|---|---|
| `__EOS_DAEMON_URL`, `__EOS_RAW_URL`, `__EOS_UI_TOKEN`, `html.native` + `data-os`, `html.fullscreen`, window drag and double-click zoom | 6 | `__EOS_HOST`, `eos-covered` (host views) |
| `eosBrowserView` | `setActiveView`, `setBounds`, `setVisible`, `overlayOpen`, `setOccluded`, `snapshot` | `pickElement`, `cancelPick` |
| `eosNotify` | `show` | |
| `webkit.messageHandlers` | `themeChanged`, `themeSnapshot`, `saveFile`, `pasteboardPaths`, `titlebarDrag`, `titlebarDblClick` | |
| Finder drop → `__eosNativeDrop` | real paths, read over DevTools from the dropped `File` objects | |
| Shell → page | `__eosThemeSnapshot`, `__nativeNavigate`, `__nativeOpenRoute`, `__eosUndo`, `__eosRedo`, `__eosTerm` (4) | `__eosPluginPreview` |
| `eosHosts` | `list` (empty), `onChange`, `onVisibility`, `onCommand` | `switchTo`, `openInWindow`, `reconnect`, `requestConnect` |
| `eosArtifacts` (15), `eosTransfer` (9) | left undefined, as in a host view today | all |
| `eosWindow` (5) | not applicable: Windows only | |

33 members work, 33 come later (artifacts 15, transfers 9, hosts 6, element picker 2, plugin
preview 1).

Not bridges, done in the shell: single instance (a later launch hands over; `Eos --status`,
`Eos --quit`), close hides and the Dock reopens, quit runs the app's shutdown hook, the app
menu with the Edit commands routed to whatever has the keyboard, full screen, window frame
restored, `eos://` links, navigation lockdown with external links in the system browser, the
content security policy, the ui-token for media loads of the dashboard document, banners with
the Eos sound (only while the window is not focused; a click opens the worker or view), native
file pickers, wake hand-off to the app, the one-time `localStorage` carry-over.

Not ported: the tray (decided), the boot splash and daemon supervision (no daemon), the dev
"Rebuild & Relaunch" item. Later phases: artifact views, host views, plugin preview, updates,
transfers, location, the element picker and device emulation, reload-after-renderer-crash.

### Environment

| Variable | Meaning |
|---|---|
| `EOS_SHELL_DATA` | the shell's data folder (default `~/Library/Application Support/com.ibrahimalbyrk.eos`) |
| `EOS_UI_DIST` | the built dashboard (default: the bundle's `Resources/dist`) |
| `EOS_ELECTRON_PROFILE` | the Electron profile to carry `localStorage` over from; `none` skips it (default `~/Library/Application Support/Eos`, read through a copy, once) |
| `EOS_SHELL_QUIET` + `TAURI_CEF_NO_ACTIVATE` | an automated run: no focus, no Dock icon, no sound |
| `EOS_SHELL_MOCK_KEYCHAIN` | keep Chromium's cookie key out of the login keychain (test data) |
| `EOS_SHELL_TRACE`, `EOS_SHELL_NETLOG` | log each request's path and status; write Chromium's net log |
| `EOS_HOME` | the core's data folder; no default yet (see above) |
| `EOS_LOG` | what is logged to stderr, as a `tracing` filter (default `warn`) |
| `EOS_DEV_DAEMON_URL`, `EOS_DEV_DAEMON_RAW_URL`, `EOS_DEV_DAEMON_HOME` | `dev-proxy`: the isolated daemon |
| `EOS_DEV_RUST_STREAM` | `dev-proxy`: let the Rust runtime serve the event stream |
| `EOS_DEV_SCRIPT`, `EOS_DEV_SCRIPT_OUT` | `dev-proxy`: steps on test views (`eos/src/dev/script.rs`) |

### Open points

- Only a person can confirm: a real window drag, ⌘C/⌘V/⌘Z in the composer and in an embedded
  view, a banner's sound and click, claude.ai sign-in in a view (`scripts/try.sh`).
- The local-network guard (`crates/eos-bridge/src/lan_guard.rs`, a proxy script per profile)
  refuses a page's requests to the LAN before any connection, and opens a view's profile
  while the user has sent that view to a LAN address or a `.local` name (the core says so
  through `BrowserViews::allow_local_network` before it navigates). In the dev driver every
  address the daemon asks for counts as asked, an agent's too; the browser feature decides
  that properly. The system's fixed proxies and exceptions are carried inside the script
  and re-read every 30 seconds; a system set to a proxy script or to auto-discovery is not
  followed (direct connections), since one proxy script cannot call another.
- Chromium still makes a few requests of its own (Google account list, component updates) in
  spite of `--disable-component-update` and `--disable-background-networking`;
  `EOS_SHELL_NETLOG` shows them.
- Notarization, the secure timestamp and a universal build are not done here.
