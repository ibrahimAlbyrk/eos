# Eos in Rust

The Rust implementation of Eos: one application that holds the window shell, the core and the agent
engine. It is built beside the TypeScript backend and replaces it in one release.

## Layout

```
assets/    files the app ships as they are (claude-plugin: the skill that teaches agents to write Eos plugins)
crates/    one crate per responsibility, in layers (see xtask/src/layers.rs)
host/      the window shell (Tauri 3 + CEF), the `eos` binary, the CEF helper: a workspace of its own
tools/     dev tooling: wire-recorder (records and replays what the daemon answers);
           *-vectors (what today's TypeScript computes, for the corpora under fixtures/)
xtask/     repo checks (`cargo xtask layers`, `cargo xtask shell`) and the update feed's release
           builder (`cargo xtask publish-update`, see docs/first-rust-release.md)
scripts/   link-sdk.sh: link the agent engine's checkout (run once per checkout, see "The agent engine");
           check.sh: everything CI runs for the main workspace; wire.sh: record the wire fixtures from
           today's daemon; replay.sh: replay them against the Rust core, in process
fixtures/  recorded responses and TypeScript-made vectors the Rust code must reproduce,
           see fixtures/README.md
           (fixtures/private is never committed)
docs/      how-tos: adding-a-feature.md is the path every feature crate follows;
           first-rust-release.md is what the first Rust release must be to install over 0.1.x
```

## Rules

- A crate depends only on lower layers; `cargo xtask layers` enforces it and every crate must be listed there.
- `unsafe` is denied workspace-wide.
- OS differences live only in the platform kit and the shell.
- The agent engine (`eos-agent-sdk`) is imported by one adapter crate only; its two provider sign-in crates also by the sign-in adapter (`ARCHITECTURE.md`, "The agent engine").

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
eos-apply/     the update applier: swaps the staged app in while Eos is closed (serde_json only)
vendor/        tauri-runtime-cef 3.0.0-alpha.7 with our patches applied
patches/       those patches as diffs (scripts/check-patches.sh proves vendor = upstream + patches)
bundle/        Info.plist templates, entitlements
scripts/       env, check, bundle, sign, dev, try, the isolated daemon
tests/         smoke run, browser run on a local page, memory measurement, local-network
               probe, proxy-script test; guard.py stops what a killed run started
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
python3 tests/browser_smoke.py <Eos.app>  # the browser on hidden views, driving a page served from a
                                  # temporary folder; a plugin preview; 28 checks
python3 tests/artifact_smoke.py <Eos.app> # artifact views against a local page standing in for claude.ai:
                                  # sign-in window, tab, peek (zoom, shield), reload swap, stills
python3 tests/lan_probe.py <Eos.app>
python3 tests/memory.py <Eos.app> # the app's memory with the dashboard open (see "Memory")
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
or its stream, and a request is always answered, also when its task dies. A release build
opens `~/.eos` when `EOS_HOME` is not set; a development build has no default: without it
the Rust core does not start, so nothing opens the real `~/.eos` by accident
(`eos_bridge::launch`). Only a release build on the user's own `~/.eos` reaches other
computers (the phone's relay, paired computers): never a development build, a test or a
copy of a data folder.

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

The daemon (`scripts/daemon.sh`) runs on a copy of the data folder, ports 7490/7491
(`scripts/dev-env.sh`: every run can name its own copy, output folder and ports), its own
`HOME`, no launchd, `CLAUDE_CONFIG_DIR` at an empty folder that must stay empty. The Rust
core opens the same isolated folder, so both sides share one ui-token and one set of data.

**A dev run works on a copy of real data, so it may not act for the user**
(`crates/eos-bridge/src/dev/guard.rs`), on either side:

- the proxy forwards the daemon's reads and refuses every write except the file and git
  watches and the stream's focus, and the one read that makes the daemon start a `claude`
  process (`GET /commands`); there is no switch to turn that off;
- the Rust core runs agents itself, so before its router sees a request the dev run refuses
  (403, "refused in a dev run") whatever starts an agent, a model call or a command,
  connects to another computer or the relay, or changes files outside the copied data
  folder. Three lists say which route is which: `REFUSED_ROUTES` (spawn, message, resume,
  rewind, a side question, "dream now", terminals and `!` commands, transfers, sync, …),
  `FOLDER_ROUTES` (the Files and Changes panels: let through only when every path the
  request names lies inside the data folder) and `HARMLESS_ROUTES`. A route that is not a
  plain read and is on none of them is refused, and a test over the composed app fails
  until it is classified. `EOS_DEV_ALLOW_AGENTS=1` lets a run that is meant to try these
  through; the launcher gives the app the isolated `CLAUDE_CONFIG_DIR` either way.

The browser panel's routes are the Rust core's; its tabs are the shell's views. The daemon's
notifications become native banners.

### What the dashboard gets (bridge inventory)

Everything is a same-origin route under `/_shell/` carrying the ui-token, plus one event
stream. Members of the Electron preload and of main's calls into the page:

| Surface | Now | Later |
|---|---|---|
| `__EOS_DAEMON_URL`, `__EOS_RAW_URL`, `__EOS_UI_TOKEN`, `html.native` + `data-os`, `html.fullscreen`, window drag and double-click zoom, `__EOS_HOST` and `eos-covered` (host views) | 8 | |
| `eosBrowserView` | `setActiveView`, `setBounds`, `setVisible`, `overlayOpen`, `setOccluded`, `snapshot`, `pickElement`, `cancelPick` | |
| `eosNotify` | `show` | |
| `webkit.messageHandlers` | `themeChanged`, `themeSnapshot`, `saveFile`, `pasteboardPaths`, `titlebarDrag`, `titlebarDblClick` | |
| Finder drop → `__eosNativeDrop` | real paths, read over DevTools from the dropped `File` objects | |
| Shell → page | `__eosThemeSnapshot`, `__nativeNavigate`, `__nativeOpenRoute`, `__eosUndo`, `__eosRedo`, `__eosTerm` (4), `__eosPluginPreview` (called in a hidden view of its own) | |
| `eosHosts` | `list`, `switchTo`, `openInWindow`, `reconnect`, `requestConnect`, `onChange`, `onVisibility`, `onCommand` | |
| `eosArtifacts` | `warm`, `peek`, `unpeek`, `attach`, `setBounds`, `setVisible`, `detach`, `reload`, `still`, `state`, `onState`, `onAction`, `account`, `signIn`, `signOut` | |
| `eosTransfer` (a host's view running this computer's dashboard) | `list`, `destination`, `chooseFolder`, `pull`, `push`, `act`, `clear`, `reveal`, `onChange` | |
| `eosWindow` (5) | not applicable: Windows only | |

66 members work; `eosWindow` is the Windows shell's. A host's view gets `__EOS_HOST`,
`eosHosts`, `eosTransfer`, the window drag and the theme handlers, and none of the rest.

Not bridges, done in the shell: single instance (a later launch hands over; `Eos --status`,
`Eos --quit`), close hides and the Dock reopens, quit runs the app's shutdown hook, the app
menu with the Edit commands routed to whatever has the keyboard, full screen, window frame
restored, `eos://` links, navigation lockdown with external links in the system browser, the
content security policy, the ui-token for media loads of the dashboard document, banners with
the Eos sound (only while the window is not focused; a click opens the worker or view), native
file pickers (`/pick-directory`, `/pick-file`: only for the dashboard's own document), wake
hand-off to the app, the one-time `localStorage` carry-over, the browser's tabs as views
(`eos-mod-browser` over `BrowserViews`; a device-sized tab is centered in the panel), the
plugin preview (a hidden view of the dashboard's bundle, captured over DevTools: a hidden
view keeps painting, so no off-screen rendering mode is used), the system opener for the
core's sign-in pages, the PDF viewer for the raw-content origin, the core's banners
(`notification:fire`; a click on one raised on a paired computer opens it in that
computer's view), a wake probes the links to paired computers.

**Artifact views** (`eos_bridge::artifacts`, the pool and its rules, tested without a
window; `eos-shell/src/views/artifacts.rs`): the claude.ai viewer in a child view, a
profile per Claude sign-in (`view-claude-<login>`), one live view moving between warm, the
peek and a tab with no reload, a reload behind a ready view that swaps once ready, a pool
of 4 (least recently used, idle 5 min), stills per `slug@version` under
`artifact-stills/` (newest 300), only the viewer's paths stay in a view (anything else:
the system browser, or "needs sign-in"). The peek's half zoom and its shield are a script
in an isolated world: a closed shadow root, a binding only that world can call, trusted
clicks only. Sign-in is the site's own page in a window of its own in that profile; it
ends when a `sessionKey` cookie is there and the page has left the sign-in pages. The
Electron partitions' sessions cannot be read by Chromium here: each sign-in signs in once.

**Views of paired computers** (`eos_bridge::hosts`, `eos-shell/src/views/hosts.rs`): one
view per host filling the window, a profile each (`view-host-<id>`), its own door on its
request context (`HostViewService`): only `/h/<id>/…` on both origins, with the view's
token on every request (the core classifies it as that host's view with
`Callers::classify_for`), a content policy pinned to that prefix, this computer's
dashboard when the host speaks the same API, else the host's bundle from `/h/<id>/ui/`.
While one covers the dashboard the artifact views stay hidden.

Not ported: the tray (decided), the boot splash and daemon supervision (no daemon), the dev
"Rebuild & Relaunch" item. Later: reload-after-renderer-crash, whether a tab is making
sound (the tab list says `audible: false`), throttling a hidden artifact view once its
still is taken (they keep painting, at most four).

### Memory

Measured on the release bundle (`tests/memory.py`, Apple M4, macOS 27.3): the dashboard with
one long chat open in a 1280×820 window that keeps painting, `phys_footprint` of every
process 40 s after the page is ready, a fresh shell profile per run, five runs each, other
agents building on the Mac meanwhile (load 11–60). Median (range), MB:

| | Total | Processes | Browser | GPU | Renderer | Network | Storage | Proxy script |
|---|---|---|---|---|---|---|---|---|
| The app as built (core in process) | **362 (359–366)** | 6 | 54 | 190 | 93 | 9 | 6 | 9 |
| Same, network service in process (`EOS_SHELL_NETWORK_IN_PROCESS`) | **353 (352–361)** | 5 | 54 | 191 | 93 | — | 6 | 9 |
| The shell alone (no Rust core, `EOS_HOME=`) | 357 (349–358) | 6 | 45 | 192 | 94 | 9 | 6 | 9 |
| Electron 42, same page (the shell memory study) | 352 (345–358) | 4 | 56 | 199 | 85 | 9 | in browser | — |
| The shell gate's defaults (the study) | 490 (487–495) | 6 | 107 | 207 | 105 | 25 | 19 | — |

What brought it down from the gate's 490 MB, all in `eos-bridge/src/chromium.rs` and the two
`build.rs` files:

- **The CEF framework is mapped at launch.** The runtime `dlopen()`s the framework, and for
  a library loaded that way macOS writes its 12 MB of relocated constant data in every
  process. The app and the helper executables now name the framework in a (weak) load
  command, so dyld maps it at launch and those pages stay clean: 0 MB of the framework's
  `__DATA_CONST` is dirty in the renderer (`memory.py --vmmap`), and every process is
  12–17 MB smaller. `scripts/bundle.sh` rewrites the path for the helpers and fails when
  an executable lacks the load command. Outside a bundle the program still starts and falls
  back to `dlopen`.
- **No component updater** (`--disable-component-update`): 51 MB in the browser process,
  135 MB on disk, and no traffic to Google's update servers. There is no Widevine and no
  component refresh between app releases, as in Electron.
- **No warm spare renderer** (`SpareRendererForSitePerProcess` off): 25 MB and one process;
  a new view's first load starts its renderer cold (about 130 ms). Electron runs without it.
- Every switch is spelled `--name`: the runtime hands a bare name to Chromium as a
  positional argument, where it silently does nothing. `Launch::problems` refuses such a
  list, the shell does not start on one, and a test walks every combination.

What is left above Electron's 352 MB is two things Electron's shell does not have: the
local-network guard's proxy script, which Chromium runs in a process of its own (9 MB), and
the Rust core inside the browser process (9 MB, in place of a 150 MB Node daemon). The GPU
process and the renderer are the page's own cost, the same in both shells. The storage
service process (6 MB) can only go with a patch to CEF.

### Environment

| Variable | Meaning |
|---|---|
| `EOS_SHELL_DATA` | the shell's data folder (default `~/Library/Application Support/com.ibrahimalbyrk.eos`) |
| `EOS_UI_DIST` | the built dashboard (default: the bundle's `Resources/dist`) |
| `EOS_ELECTRON_PROFILE` | the Electron profile to carry `localStorage` over from; `none` skips it (default `~/Library/Application Support/Eos`, read through a copy, once) |
| `EOS_SHELL_QUIET` + `TAURI_CEF_NO_ACTIVATE` | an automated run: no focus, no Dock icon, no sound |
| `EOS_SHELL_MOCK_KEYCHAIN` | keep Chromium's cookie key out of the login keychain (test data) |
| `EOS_SHELL_TRACE`, `EOS_SHELL_NETLOG` | log each request's path and status; write Chromium's net log |
| `EOS_SHELL_NETWORK_IN_PROCESS` | run Chromium's network service inside the browser process: one process and about 9 MB less, without its crash isolation and its own sandbox (off by default; see "Memory") |
| `EOS_SHELL_PAINT_WHEN_COVERED` | keep painting while other windows cover the app's: for memory measurements |
| `EOS_HOME` | the core's data folder; `~/.eos` in a release build, no default in a development build (see above) |
| `EOS_LOG` | what is logged to stderr, as a `tracing` filter (default `warn`) |
| `EOS_DEV_DAEMON_URL`, `EOS_DEV_DAEMON_RAW_URL`, `EOS_DEV_DAEMON_HOME` | `dev-proxy`: the isolated daemon |
| `EOS_DEV_RUST_STREAM` | `dev-proxy`: let the Rust runtime serve the event stream |
| `EOS_DEV_ALLOW_AGENTS` | `dev-proxy`: `1` lets the Rust core answer what a dev run refuses otherwise: agents, model calls, commands, other computers, files outside the data folder |
| `EOS_DEV_SCRIPT`, `EOS_DEV_SCRIPT_OUT` | `dev-proxy`: steps on test views (`eos/src/dev/script.rs`) |
| `EOS_DEV_ARTIFACT_ORIGIN` | `dev-proxy`: a page on `http://127.0.0.1:<port>` standing in for claude.ai in the artifact views (`tests/artifact_smoke.py`) |

### Open points

- Only a person can confirm: a real window drag, ⌘C/⌘V/⌘Z in the composer and in an embedded
  view, a banner's sound and click, claude.ai sign-in and a real artifact
  (`scripts/try.sh artifacts <link>`), a view of a paired computer (a dev run refuses to
  reach one).
- The local-network guard (`crates/eos-bridge/src/lan_guard.rs`, a proxy script per profile)
  refuses a page's requests to the LAN before any connection, and opens a view's profile
  while the user has sent that view to a LAN address or a `.local` name (the core says so
  through `BrowserViews::allow_local_network` before it navigates). What counts as asked
  for is the browser feature's rule (`crates/eos-mod-browser`): an address the user typed
  or an agent's tool named, and back, forward or reload chosen by either; never a page's
  own redirect, link or popup. The opening is per profile, so while one tab of a session is
  on the local network its other tabs can reach it too. The system's fixed proxies and exceptions are carried inside the script
  and re-read every 30 seconds; a system set to a proxy script or to auto-discovery is not
  followed (direct connections), since one proxy script cannot call another.
- Chromium still makes a few requests of its own (Google account list, component updates) in
  spite of `--disable-component-update` and `--disable-background-networking`;
  `EOS_SHELL_NETLOG` shows them.
- Notarization, the secure timestamp and a universal build are not done here.
