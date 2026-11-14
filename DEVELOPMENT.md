# Developing Eos

Eos is one Rust application that holds the window shell, the core and the agent engine. The React
dashboard (`app/ui`) is its user interface. Commands below run at the repository root unless they
say otherwise.

## Layout

```
app/ui/    the React dashboard (its own npm package), bundled into the app
assets/    files the app ships as they are (claude-plugin: the skill that teaches agents to write Eos plugins;
           pdfjs: the PDF viewer of the raw-content origin)
crates/    one crate per responsibility, in layers (see xtask/src/layers.rs)
host/      the window shell (Tauri 3 + CEF), the `eos` binary, the CEF helper: a workspace of its own
tools/     dev tooling: wire-recorder (replays the recorded wire against the Rust core)
xtask/     repo checks (`cargo xtask layers`, `cargo xtask shell`) and the update feed's release
           builder (`cargo xtask publish-update`, see docs/first-rust-release.md)
scripts/   check.sh: everything CI runs for the main workspace; replay.sh: replay the recorded wire
           against the Rust core, in process; local-sdk.sh: build against a local engine checkout
           (see "The agent engine")
fixtures/  what the 0.1.x app answered and computed, frozen: the recorded wire and the vectors the
           Rust code must reproduce, see fixtures/README.md (fixtures/private is never committed)
docs/      how-tos: adding-a-feature.md is the path every feature crate follows;
           first-rust-release.md is what the first Rust release must be to install over 0.1.x
ios/       the iPhone client; relay/: the relay server; update-server/: the update feed's server
```

## Rules

- A crate depends only on lower layers; `cargo xtask layers` enforces it and every crate must be listed there.
- `unsafe` is denied workspace-wide.
- OS differences live only in the platform kit and the shell.
- The agent engine (`eos-agent-sdk`) is imported by one adapter crate only; its two provider sign-in crates also by the sign-in adapter (`ARCHITECTURE.md`, "The agent engine").

## Check

```bash
scripts/check.sh         # fmt, clippy -D warnings, tests, layers, shell rules; never builds Tauri or CEF
host/scripts/check.sh    # the host workspace: fmt, clippy, the bridge's dev guard, patches, the same repo guards
```

## The agent engine

Agent sessions run on `eos-agent-sdk`, a separate (private) repository, taken as git dependencies
pinned to one commit (`eos-agent-sdk`, `eos-agent-core`, … in `Cargo.toml`, every `rev` the
same); both workspaces resolve them from there, so a fresh clone builds. Cargo fetches them with the
git command line (`net.git-fetch-with-cli` in `.cargo/config.toml`), which uses your own git
credentials: with the GitHub CLI signed in, `gh auth setup-git` once is enough. To move to a newer
engine, push it to the engine's `main`, change every `rev` in `Cargo.toml` and run `cargo metadata
--format-version 1 >/dev/null` here and in `host/`: both lockfiles change with it.

To work on the engine and Eos together, build against a local checkout:

```bash
scripts/local-sdk.sh ../eos-agent-sdk   # both workspaces use that checkout's crates
scripts/local-sdk.sh                    # say which engine is used
scripts/local-sdk.sh --off              # back to the pinned commit
```

It writes the git-ignored `.cargo/local-sdk.toml`, a `[patch]` of the engine's crates that
`.cargo/config.toml` includes when it exists (the host workspace warns that two of the patched
crates, the engine's test kit and mock API, are not in its graph). While it is on, `Cargo.lock` and
`host/Cargo.lock` name the local crates: commit neither, and turn it off before pinning the new
commit. Only `eos-engine` (sessions) and `eos-auth` (sign-in) depend on the engine's crates.

## Build and install from source

```bash
eos build                           # build this checkout, install it as /Applications/Eos.app, open it
eos restore                         # put the previous app back (run again to come back)
eos start | stop | restart          # open the installed app, ask it to quit as its Quit menu does, both
eos status                          # what the running app answers to `Eos --status`; exit 1 when it is not running
eos help
```

`eos` is `scripts/eos`, a launcher that runs `cargo xtask eos …` (`xtask/src/eos.rs`) in the
checkout it belongs to, from any folder; it follows its own link to find that checkout and says
so when the checkout or cargo is missing. `eos build` is `cargo xtask install` and `eos restore`
is `cargo xtask install --restore`; use those in a checkout before the command is linked. Every
install links `~/.local/bin/eos` (`$EOS_BIN_DIR/eos` when that is set) to this checkout's
launcher: a missing one is created, a link to another Eos launcher (another checkout, or the
0.1.x app's `manager/bin/eos`) is replaced, and a file or a link to anything else is left alone
with a message. A command of the 0.1.x `eos` (`chat`, `logs`, …) answers that it is not
available and what to use instead.

What the host workspace needs comes from `host/scripts/setup.sh`, which the build runs first
("Build, check, run" below). Options: `--no-open`; `--identity <name>` signs with another
keychain identity, `-` ad hoc; `cargo xtask install --dest <Eos.app>` installs elsewhere.
`EOS_HOME` names the data folder the install belongs to (default `~/.eos`, as for the app).

1. **Build**: `host/scripts/setup.sh`, then `bundle.sh release` with the app's identity
   (`com.ibrahimalbyrk.eos`) and no update channel, then `sign.sh` with your Developer ID
   identity; with none in the keychain it signs ad hoc and says so. An ad hoc build opens as
   usual (a build made on this Mac carries no quarantine flag, so Gatekeeper does not check it),
   but its signature changes with every build: macOS may ask again for location, local network
   and keychain access after each install.
2. **Quit**: the installed app is asked to quit as its Quit menu does (30 s), the 0.1.x
   app's daemon is stopped through launchd (`eos_update::legacy`, the call the app's own first
   start makes; only on the user's own `~/.eos`), and then nothing may run from the bundle.
   Nothing is killed: what still runs is listed and nothing is changed. Nothing starts either
   while an in-app update is being applied (`~/.eos/updates/apply.json`).
3. **Swap**: the new app is moved beside the installed one (copied when it lies on another
   volume), then two renames: the installed app aside, the new one in. A failure up to there is
   undone. The replaced app goes to `~/.eos/updates/previous/Eos.app`, where the in-app updater
   keeps the app an update replaced: one previous app, whoever replaced it. An interrupted run's
   leftovers (hidden `.Eos.app.*` beside the app or the kept one) stop the next run until you
   move them away.
4. **Open** it, and say what was installed, where the previous app is and how to go back.

`--restore` makes the same checks and trades the installed and the kept app; a restored
0.1.x app starts its daemon again when it opens.

The installed build is the user's app: a release build that opens `~/.eos` and reaches the
phone, paired computers, sync and the accounts (`crates/eos-app/src/reach.rs`). It does not
update itself: it has no `update.json`, so Settings › Updates says "Built from source"; run the
command again for a newer build.

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
bundle/        Info.plist templates, entitlements, the app icon, the banner sound
location/      the CoreLocation helper's source (`EosLocation.app`, built by scripts/bundle.sh)
saver/         the screen saver's source, Swift + Metal (`Eos.saver`, built by scripts/bundle.sh)
scripts/       setup, env, check, bundle, sign, dev, try, launch on test data
tests/         smoke run, browser run on a local page, memory measurement, local-network
               probe, proxy-script test; guard.py stops what a killed run started
.work/         build caches (not in git): cmake, ninja and esbuild (scripts/setup.sh), cargo
               registry, CEF (~460 MB), target, bundles
```

The portable half of the shell lives in the main workspace and is tested there without a
window: `crates/eos-bridge` (transport, URL space, token rule, bridges, panel geometry, storage
carry-over, single instance, window state, the dev guard) and `crates/eos-core` (`shell`: the
view ports the shell implements).

### Build, check, run

Needs: rustup's `cargo`, Xcode (`swiftc`, `codesign`), Node with `npm` for the dashboard (20.19,
or 22.12 or later), `curl`. Everything else comes from `scripts/setup.sh`, run once on a clean
checkout and again whenever you like (it keeps what is in place and prints what it did):

- cmake and ninja, pinned releases from their GitHub release pages, checked against the SHA-256
  in the script, under `.work/tools/` (`env.sh` puts them on `PATH`);
- esbuild, the release `eos-plugin-build` speaks (`ESBUILD_VERSION`), from the npm registry,
  checked against the SHA-256 in the script, under `.work/tools/esbuild-<version>/`: the bundle
  ships it, and development builds and tests of this checkout find it there
  (`eos_plugin_build::locate`);
- `npm ci` in `app/ui`, inside this checkout only, when its lockfile changed since the last
  install, and the dashboard's build (`app/ui/dist`) when it is missing or older than its sources.

CEF (~460 MB) is fetched by `cef-dll-sys`'s build script on the first build into `.work/cef`
and checked against the CEF builds index's SHA-1. `bundle.sh` and `check.sh` stop with one line
naming `scripts/setup.sh` when something it provides is missing; `try.sh build` runs it itself.

```bash
scripts/setup.sh                  # a clean checkout → buildable (tools, esbuild, the dashboard)
scripts/check.sh                  # fmt, clippy, the bridge with its dev guard, patches, repo guards
scripts/bundle.sh release         # Eos.app as it ships, with the five helper apps → .work/bundle/release/
scripts/bundle.sh test            # the same with `dev-run` (the dev guard, the test drivers' hooks)
                                  # → .work/bundle/test/; every test driver below runs this one
scripts/dev.sh                    # debug bundle with `dev-run` on the private data copy
scripts/sign.sh <Eos.app> [-]     # local Developer ID signature (- : ad hoc), --timestamp=none, nothing sent anywhere
python3 tests/smoke.py <Eos.app>  # launches quietly, 40 checks, quits (never types into a page)
python3 tests/browser_smoke.py <Eos.app>  # the browser on hidden views, driving a page served from a
                                  # temporary folder; a plugin preview; 28 checks
python3 tests/artifact_smoke.py <Eos.app> # artifact views against a local page standing in for claude.ai:
                                  # sign-in window, tab, peek (zoom, shield), reload swap, stills
python3 tests/lan_probe.py <Eos.app>
python3 tests/memory.py <Eos.app> # the app's memory with the dashboard open (see "Memory")
python3 tests/responsiveness.py <Eos.app>  # clicks the dashboard's harmless controls 20 times
                                  # each, fails over budget (see "Responsiveness")
scripts/try.sh build              # setup when needed, the test bundle, signed locally
scripts/try.sh                    # for a person: see the header of the script
```

A change to the shell, the bridge or the threads the core runs on is finished when
`scripts/check.sh` of both workspaces passes and, on the rebuilt test bundle,
`smoke.py`, `browser_smoke.py`, `artifact_smoke.py` and `responsiveness.py`.

`scripts/bundle.sh` assembles the bundle itself (binary, dashboard, framework, helper apps);
the Tauri CLI is not used, because it compiles its own copy of the helper and offers no way to
build ours. The Rust core serves every route of the dashboard except the metered provider
settings (`/api/backends*`) and `/metrics` (it had a listener to count; there is none): a route
it does not declare is a 404. Everything a bundle ships comes from this tree (`assets`,
`host/bundle`, `host/location`, `host/saver`, the dashboard's `app/ui/dist` and two of its
font packages, the screen saver's clock faces) and from `scripts/setup.sh` (esbuild).

`Contents/Resources` holds, beside the dashboard (`dist`), `esbuild`, `claude-plugin`,
`pdfjs`, the icon and the banner sound, two bundles of their own, each signed by itself
before the app is sealed (`sign.sh`): `EosLocation.app` (the location helper) and
`Eos.saver`, the screen saver. The saver is a loadable bundle the system's screen-saver host
runs, never the app: `EosSaver` (Swift, `swiftc -emit-library -Xlinker -bundle`, arm64,
macOS 14+), its `Info.plist` with the principal class `EosSaverView`, and in its resources
the scene's shader as source (`FirstLight.metal`, compiled when the saver starts, so the
build needs no Metal toolchain), the picker's thumbnails and the clock's Geist and IBM Plex
Mono faces. `bundle.sh` fails when the binary lacks the principal class.

### The core, and a dev run

The binary builds `eos-app` from the data folder named by `EOS_HOME` and the shell reaches its
router in process (`eos_bridge::RouterCore`): each page request becomes a runtime request
tagged with its caller (`eos-app`'s `callers().classify` on the ui-token; the raw origin is
never the dashboard), whole bodies are sent at once and streams chunk by chunk at the
reader's pace, a route's own 206 passes through, a request the page drops cancels the handler
or its stream, and a request is always answered, also when its task dies. A release build
opens `~/.eos` when `EOS_HOME` is not set; a dev run (a build with the `dev-run` feature:
`bundle.sh test` or `debug`) has no default: without it the Rust core does not start, so
nothing opens the real `~/.eos` by accident (`eos_bridge::launch`). Only a release build on the
user's own `~/.eos` acts as the user beyond this computer (the phone's relay, paired computers,
the sync vault, the update feed, Eos's own reads of the user's accounts: one switch,
`crates/eos-app/src/reach.rs`): never a dev run, a test or a copy of a data folder.

`scripts/launch.sh` opens a dev-run bundle on a copy of real data (`scripts/dev-env.sh`: every
run can name its own copy and output folder; a missing copy is made from
`$EOS_DEV_DATA/home`), with `CLAUDE_CONFIG_DIR` at an empty folder inside the copy that must stay
empty, and refuses a bundle without the dev guard. What became of each request is logged at
debug level under `eos::bridge` (`EOS_LOG=eos::bridge=debug`, the launcher's default), and
`Eos --status` counts what the core served and refused and lists the routes it served.

**A dev run works on a copy of real data, so it may not act for the user**
(`crates/eos-bridge/src/dev/guard.rs`): the Rust core runs agents itself, so before its router
sees a request the dev run refuses (403, "refused in a dev run") whatever starts an agent, a
model call or a command, connects to another computer or the relay, or changes files outside
the copied data folder. Three lists say which route is which: `REFUSED_ROUTES` (spawn,
message, resume, rewind, a side question, "dream now", terminals and `!` commands, transfers,
sync, …), `FOLDER_ROUTES` (the Files and Changes panels: let through only when every path the
request names lies inside the data folder) and `HARMLESS_ROUTES`. A route that is not a plain
read and is on none of them is refused, and a test over the composed app
(`crates/eos-bridge/tests/dev_guard.rs`, run by `host/scripts/check.sh`) fails until it is
classified. `EOS_DEV_ALLOW_AGENTS=1` lets a run that is meant to try these through; the
launcher gives the app the isolated `CLAUDE_CONFIG_DIR` either way.

A dev run also carries what the test drivers drive the app with: the dev script
(`eos/src/dev/script.rs`: steps on test views, browser routes, artifact calls), the measuring
probe (`EOS_SHELL_PROBE`) and a local page standing in for claude.ai (`EOS_DEV_ARTIFACT_ORIGIN`).
A release build has none of them.

The browser panel's routes are the Rust core's; its tabs are the shell's views.

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
`eosHosts`, `eosTransfer`, the window drag, the theme report (the window's background; no
crossfade still) and, when it runs this computer's own dashboard, saving a file into
Downloads; none of the rest.

Not bridges, done in the shell: single instance (a later launch hands over; `Eos --status`,
`Eos --quit`), close hides and the Dock reopens, quit runs the app's shutdown hook, the app
menu with the Edit commands routed to whatever has the keyboard, the screen saver's two
items in the Eos menu (below; only where `eos-platform` has a screen saver and the bundle
ships `Eos.saver`), full screen, window frame
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
the system browser, or "needs sign-in"). A view nobody sees is frozen (the page lifecycle's
freeze) once its still is taken, and runs again when placed or reloaded. `account()` reads
the site's account document with the profile's cookies from the browser process (Electron's
`session.fetch`), kept 10 minutes (a failed read: one). The peek's half zoom and its shield are a script
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

**The screen saver** (`eos_platform::ScreenSaver`, macOS only; the shell's
`screen_saver_action`): the Eos menu's **Lock Screen** asks the login window's screen-saver
daemon to start the saver (`ScreenSaverController.controller.screenSaverStartNow` through
`osascript -l JavaScript`), so it runs on every display (`open -a ScreenSaverEngine` would
show it on one); with "Require password immediately" in Lock Screen settings that is a real
lock, and the Mac stays awake for the phone. **Install Screen Saver…** copies `Eos.saver`
into `~/Library/Screen Savers` (made beside the older copy, then swapped in) and opens the
settings where a saver is picked (Wallpaper on macOS 26 and later, Screen Saver before):
macOS has no supported way to select one, so picking "Eos" there is the user's step. A
failed install shows an alert ("Couldn’t install the Eos screen saver"). Both run off the
main thread; tests install into a temporary folder and never start the saver.

Not ported: the tray (decided; its screen-saver items are the Eos menu's now), the boot splash and daemon supervision (no daemon), the dev
"Rebuild & Relaunch" item. Whether a tab is making sound stays unknown (the tab list says
`audible: false`): CEF tells an app about a page's sound only through `CefAudioHandler`,
which is an audio *capture* (made for windowless apps that play the sound themselves: the
captured stream is taken off the speakers), and declining the capture leaves only the moment
sound starts, never when it stops. Chromium knows (`WebContents::IsCurrentlyAudible`) but
CEF exposes no such call, and CEF ships prebuilt here, so the vendored runtime has nothing to
patch.

A view whose renderer dies (`eos_bridge::recovery`) is reloaded once: the dashboard, a
browser tab, a paired computer's view; dying again within ten seconds of that reload it is
left alone, so a page that crashes as it boots cannot spin. An artifact view says "The page
stopped (<reason>)" and the dashboard offers Retry. A plugin preview, a sign-in page or the
splash is not kept.

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

### Responsiveness

`tests/responsiveness.py` on the release bundle: 20 clicks of each kind on the private data
copy, the window quiet and painting while covered, other agents building meanwhile. Before is
the bundle at `5eb11398`, just before the fixes below; after is this one. Milliseconds; load
4–7 for this table:

| Click | paint p95 / max | UI-thread stall, max | the core held a trivial request, max |
|---|---|---|---|
| side panel opens on a chat's first browser tab | 48 / 64 → 48 / 64 | 30 → 0 | 1 → 2 |
| switch to the Browser tab | 48 / 72 → 40 / 64 | 27 → 0 | 5 → 1 |
| model picker opens | 40 / 40 → 40 / 40 | 0 → 0 | 52 → 0 |
| switch chats | 57 / 62 → 64 / 65 | 20 → 0 | 9 → 9 |
| switch chats with a page in the browser panel | 48 / 48 → 48 / 48 | 17 → 0 | 8 → 8 |
| Settings opens | 48 / 56 → 48 / 48 | 0 → 0 | 2 → 1 |

The gate fails the bundle before (four stalls during bridge calls, a 52 ms wait in the core)
and passes after. The difference grows with load. The requests a chat switch sends, timed in
the page alone and all at once, load 8–20:

| | Before | After | Node daemon |
|---|---|---|---|
| transcript, subagent and prompt events (1–10 ms alone), sent with the git-backed routes | 77–218 | 2–8 | 1–3 |
| git-backed routes (diff, branches, push state, changes, conflicts), alone | 90–270 | 32–100 | 33–64 |
| the same, all at once | 300–1040 | 84–192 | 78–131 |
| `GET /api/dreams/status` (Settings) | 150–172 | 1 | 10–11 |

What made the window freeze, and the fix of each:

- **Starting a process forked the app.** The process runner cleared the child's environment
  and named `git` by its bare name, so std forked the whole process to search the child's
  `PATH`, and the calling thread waited on the exec pipe until the child had exec'd. A sample
  during a burst of git routes found both of the core's workers in `Command::spawn` three
  quarters of the time (`fork`, then `read` on that pipe). `eos-kit-proc` now finds the
  program itself, so std uses `posix_spawn`, and starts it on the blocking pool.
- **The core shared the shell's runtime of two workers.** It has its own now
  (`eos_app::runtime`, see ARCHITECTURE §5).
- **A view's profile was read from disk while the UI thread spun.** The runtime makes a view on
  the UI thread and pumps CEF's loop there until the view's profile is ready, so every chat's
  first browser tab (and an artifact's or a paired computer's view) froze the window for
  24–185 ms. The shell loads the profile first, with the UI thread free.
- **The clock came from `/bin/date`**, started and polled on a core worker several times per
  dream status. It is read in process now.

Not ours to fix here, the same with Electron: a long chat's `subagent-events` answer is 33 MB
on both sides (Node takes 330–364 ms for it); parsing it is a 60–110 ms task in the page on a
chat switch, beside the dashboard's own rendering, which reaches 150 ms under load. The run
clicks over DevTools: the path of a real mouse event through AppKit is not measured.

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
| `EOS_HOME` | the core's data folder; `~/.eos` in a release build, no default in a dev run (see above) |
| `EOS_LOG` | what is logged to stderr, as a `tracing` filter (default `warn`) |
| `EOS_DEV_ALLOW_AGENTS` | `dev-run`: `1` lets the Rust core answer what a dev run refuses otherwise: agents, model calls, commands, other computers, files outside the data folder |
| `EOS_DEV_SCRIPT`, `EOS_DEV_SCRIPT_OUT` | `dev-run`: steps on test views (`eos/src/dev/script.rs`) |
| `EOS_DEV_SCRIPT_FOLLOW` | `dev-run`: the steps file is JSON lines a test appends to, results come back the same way |
| `EOS_SHELL_PROBE` | `dev-run`: the measuring probe (`tests/responsiveness.py`): DevTools calls and clicks on the dashboard, a UI-thread heartbeat, a Chromium trace |
| `EOS_DEV_ARTIFACT_ORIGIN` | `dev-run`: a page on `http://127.0.0.1:<port>` standing in for claude.ai in the artifact views (`tests/artifact_smoke.py`) |

The scripts' own variables are in their headers: the data copy and output folder of a dev run
(`EOS_DEV_DATA`, `EOS_DEV_HOME`, `EOS_DEV_OUT`: `scripts/dev-env.sh`), the bundle's identifier,
dashboard, esbuild and update channel (`scripts/bundle.sh`), the build caches
(`EOS_HOST_WORK`: `scripts/env.sh`).

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
