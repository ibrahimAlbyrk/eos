# app — Electron desktop shell for the Eos dashboard

Migration milestones **M0–M6** of `docs/electron-migration/00-MIGRATION-PLAN.md`.
This package re-hosts the existing `app/ui` React dashboard in Electron, serving it
over a re-registered `eos://app/` custom scheme and connecting it to the
**already-running local Eos daemon**. The UI runs unchanged.

M2 adds pixel-perfect macOS window chrome: `titleBarStyle:'hiddenInset'`,
transparent titlebar, hidden title, full-size content, opaque pre-paint
background, traffic lights positioned to the native spot, and window-drag mapped
from the UI's own `--app-region` custom property (no `app/ui` source edits).
A/B measured against the installed native Eos.app: traffic-light centers 0px
delta, corner radius 0px delta (see `verify/m2-chrome.png` vs
`verify/m2-native-ref.png`).

M3 re-provides the full Swift↔JS bridge from the Electron side (no `app/ui`
edits): a `window.webkit.messageHandlers` shim (`themeChanged`, `themeSnapshot`,
`saveFile`, reply-style `pasteboardPaths`, no-op titlebar handlers) routing to
main IPC (`src/main/bridge.ts`), a terminal-aware Edit menu driving
`__eosUndo`/`__eosRedo`/`__eosTerm.*` (`src/main/menu.ts`), Finder DnD
interception in the preload → `__eosNativeDrop`/`__eosDragState`, and persisted
theme (`src/main/theme.ts`) so the opaque pre-paint background tracks dark/light.
`themeChanged` repaints the native window bg (dark `#1a1a1a` ↔ light `#f6f1e6`);
`themeSnapshot` feeds the crossfade via `capturePage` → `__eosThemeSnapshot`. See
`verify/m3-theme-dark.png` / `verify/m3-theme-light.png`.

M4 adds the menu-bar Tray, notifications, and app lifecycle (main-process,
read-only against the running daemon):
- A shared main-process SSE reader (`src/main/sse.ts`) + 4s `/workers` poll feed
  a ported `FleetReducer` + `CompletionQueue` (`src/main/fleet.ts`).
- Tray (`src/main/tray.ts` + `src/main/tray-paint.ts`): the DawnStar breathing
  icon + running count and the completion pill (check/cross + name + drain + `+N`)
  are canvas-rendered `nativeImage` frames (nativeImage can't rasterize SVG)
  pushed on a timer. Left-click shows the window, right-click → Open/Quit. See
  `verify/m4-tray.png`.
- Notifications (`src/main/notifications.ts`): `notification:fire` → a native
  Notification only when the app is unfocused; click → `__nativeNavigate`.
- Lifecycle: `requestSingleInstanceLock` (2nd launch focuses the 1st), close
  HIDES (background-app, web state survives), activate re-shows, tray Quit.

M5 adds the launch splash + update flow:
- `src/main/splash.ts` — a frameless vibrancy panel (`vibrancy:"popover"` +
  `visualEffectState:"active"` — the ONE window where native vibrancy is correct;
  the main window stays opaque) reproducing the Swift splash (64px floating logo,
  "Eos", sweeping indeterminate bar, 30px corners), grown+faded on dismiss. See
  `verify/m5-splash.png`.
- `src/main/updater.ts` — the check→apply→relaunch state machine driven by the
  daemon's `/api/updates/status` + `/health` sourceStamp, ending in reload-in-place
  or `app.relaunch()`. **The destructive apply (`POST /api/updates/apply`, which
  rebuilds+restarts the daemon) is STUBBED — never called; binary apply + a signed
  release feed via electron-updater is M6.**

M6 adds packaging: `npm run make` produces a packaged `Eos.app` in
`out/` (product "Eos", bundle id `com.ibrahimalbyrk.eos`) with the built
`app/ui/dist` bundled into `Contents/Resources/dist` (so it serves `eos://app/`
without the source tree — `resolveUiRoot` uses `process.resourcesPath/dist` when
`app.isPackaged`). See `verify/m6-packaged.png`.

## Packaging (M6)

```bash
npm run make               # host arch (arm64) → out/Eos-darwin-arm64/Eos.app
npm run make -- --arch=universal   # universal arm64+x64 (downloads the x64 Electron, merges via @electron/universal)
EOS_DMG=1 npm run make     # also produce a .dmg (needs the native `appdmg`)
```

- **Output** goes to `out/` ONLY — it never writes to or launches the installed
  `/Applications/Eos.app`. The packaged app now carries the canonical `Eos.app`
  name + bundle id `com.ibrahimalbyrk.eos`; don't launch it while the old native
  Eos.app is running (shared bundle id would confuse LaunchServices).
- **Size:** ~307 MB installed / ~120 MB zipped (arm64) — the Chromium/Electron
  runtime cost, in line with the plan's estimate. The `packagerConfig.ignore`
  keeps the nested `app/ui` (source + node_modules) and dev files out of the
  bundle; the UI ships only as `Resources/dist` via `extraResource`. Universal is
  larger (both arch slices merged).
- **Coexistence with `app/build.sh`:** both shells build from the SAME
  `app/ui/dist`, to different outputs — `app/build.sh` → `/Applications/Eos.app`
  (Swift), Forge → `app/out/` (Electron). Nothing auto-replaces
  `/Applications/Eos.app`; that swap is a deliberate post-M7 cutover.

### Signing + notarization (unsigned by default)

The default build is **unsigned (ad-hoc / linker-signed)** — it runs locally but
Gatekeeper will warn on distribution. To sign + notarize, the operator supplies
credentials via env; the config is otherwise a no-op:

```bash
# 1. Sign with a "Developer ID Application" cert (required for notarized distribution):
export EOS_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
# 2. (optional) Notarize via an App Store Connect API key:
export EOS_APPLE_API_KEY=/path/to/AuthKey_XXXX.p8
export EOS_APPLE_API_KEY_ID=XXXXXXXXXX
export EOS_APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
npm run make -- --arch=universal
```

- Signing uses Hardened Runtime + `build/entitlements.mac.plist` (only
  `com.apple.security.cs.allow-jit` — **not** `allow-unsigned-executable-memory`,
  which Electron ≥12 doesn't need).
- This checkout has **no Developer ID Application cert** (only Apple
  Development/Distribution), so the M6 build is unsigned. Notarization
  (`notarytool`, which uploads to Apple) is **not run here** — it's wired but
  requires the API-key env above and a network submit the operator performs.
- `spctl -a -vv` and `xcrun notarytool submit` are the operator's release steps.

### Binary auto-update (electron-updater) — inert hook

`src/main/updater-binary.ts` wires the shell-binary update path (Squirrel.Mac).
It is INERT unless the app is packaged, `EOS_UPDATE_FEED` is set to a generic
release feed, AND `electron-updater` is installed (`npm i electron-updater` — it's
intentionally not a dependency, to keep the build lean). A production binary
auto-update needs a signed app + a published, versioned release feed.

Packaging/signing polish + parity audit is M7.

## Dev run

```bash
cd app
npm install      # first time only
npm start        # bundles main+preload, then electron-forge start
```

`npm start` opens a window that loads the real Eos UI from `eos://app/index.html`.
It probes the running daemon at `http://127.0.0.1:7400`, reads the per-boot token
from `~/.eos/ui-token`, injects both plus the `html.native` class, and the UI
connects to the live daemon (HTTP + SSE `/stream` + the browser-panel WebSocket).

Requires the Eos daemon to already be running (start Eos.app first). This scaffold
**never spawns or restarts the daemon** — it reuses the running one.

### Useful env overrides

| Var | Effect |
|---|---|
| `EOS_DAEMON_URL` | Override the daemon origin (default `http://127.0.0.1:7400`). |
| `EOS_UI_DIST` | Override the built-UI directory (default `app/ui/dist` in dev, `Resources/dist` when packaged). |
| `EOS_ELECTRON_DISABLE_CSP=1` | Drop the entry-document CSP header (debugging). |
| `EOS_ELECTRON_CAPTURE=<path>` | After load, run in-renderer diagnostics + save a `capturePage()` PNG. |
| `EOS_ELECTRON_CAPTURE_DELAY=<ms>` | Delay before capture (default 7000). |
| `EOS_ELECTRON_CAPTURE_QUIT=1` | Exit after capturing (headless verification). |
| `EOS_TL_X` / `EOS_TL_Y` | Override `trafficLightPosition` (defaults 19 / 16 — the measured native match). |
| `EOS_ELECTRON_M2=1` | Focus the window + print bounds/drag-region probe, hold on-screen for external `screencapture -l` (M2 A/B). |
| `EOS_ELECTRON_FS_TEST=1` | With `EOS_ELECTRON_M2`: enter/leave fullscreen and log the `html.fullscreen` class toggle. |
| `EOS_ELECTRON_M3=1` | Run the bridge self-test: capture both themes, drive themeChanged/themeSnapshot/saveFile/pasteboardPaths, log verdicts, exit. |
| `EOS_ELECTRON_SAVEFILE_NOOPEN=1` | `saveFile` writes to ~/Downloads but skips the `shell.openPath` (avoids launching an app during tests). |
| `EOS_ELECTRON_M4=1` | Render + save tray frames, test the notification focus gate + close-hides/activate, then hold for an external single-instance test. |
| `EOS_ELECTRON_M4_HOLD=<ms>` | How long the M4 verify holds on-screen (default 30000). |
| `EOS_ELECTRON_M5=1` | Splash + update-flow self-test (splash only, no main window/tray): shows the splash, logs state transitions, then reload or relaunch. |
| `EOS_ELECTRON_M5_RELAUNCH=1` | With M5: exercise the `app.relaunch()` path (a `--m5-relaunched` marker prevents a loop). |
| `EOS_ELECTRON_M5_HOLD=<ms>` | How long the splash holds before the flow runs (default 9000). |

Verification snapshot used for the M1 gate:

```bash
EOS_ELECTRON_CAPTURE=verify/m1-launch.png EOS_ELECTRON_CAPTURE_DELAY=9000 \
  EOS_ELECTRON_CAPTURE_QUIT=1 npm start
```

If `app/ui/dist` is missing or stale, rebuild it (build output only, safe):
`cd ui && npm run build`.

## Scripts

- `npm run bundle` — esbuild → `.forge-build/{main,preload}.js` (single CJS files).
- `npm run typecheck` — `tsc --noEmit`.
- `npm start` — bundle, then `electron-forge start`.
- `npm run package` / `npm run make` — Forge packaging (**M6**; not signed/notarized yet).

## Layout

```
src/main/config.ts    repo-root / ui-dist / daemon-url / theme-bg resolution
src/main/daemon.ts    /health probe + poll, ~/.eos/ui-token read (lowercase hex)
src/main/scheme.ts    eos:// privileged scheme: containment guard + MIME map + CSP
src/main/index.ts     app lifecycle, BrowserWindow, nav lockdown, verify capture
src/preload/index.ts  injects __EOS_DAEMON_URL, __EOS_UI_TOKEN, html.native
```

Security/perf flags on the window: `contextIsolation:true`, `sandbox:true`,
`nodeIntegration:false`, `backgroundThrottling:false`. Preload exposes only the
three globals via `contextBridge` (never raw `ipcRenderer`). Navigation is locked
to `eos://app/*`; external links open in the system browser.

## SAFETY — hard rules (this runs inside a live Eos)

- **Never touch `/Applications/Eos.app`.** This app now carries the canonical
  product name (**"Eos"**) and bundle id (**`com.ibrahimalbyrk.eos`**); Forge
  output goes to `app/out/` only, so it never writes to or overwrites the
  installed Swift app. Don't LAUNCH the packaged app while the native Eos.app is
  running (shared bundle id would confuse LaunchServices) — dev `npm start` is safe.
- **Never run `eos build`, `eos restart`, or any `eos` daemon command.** They
  restart the daemon and crash every running worker — including the session this
  dev app is being developed in. Reuse the already-running daemon.
- **Never spawn a second daemon** or point the app at a new daemon instance.
- This package lives at `app/` (with the nested UI at `app/ui/`). Rebuilding `app/ui/dist`
  (build output) is allowed; editing `app/ui` source, `app/` (Swift), or any
  other package is not.
