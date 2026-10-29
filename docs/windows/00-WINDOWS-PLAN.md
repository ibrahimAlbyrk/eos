# Eos on Windows

Eos runs on Windows with the same design and the same behavior as on macOS. One
codebase: what differs between the two systems sits behind one platform seam,
and everything above it (core, routes, UI) never asks which OS it is on.

## Scope

- **Targets:** Windows 10 x64, Windows 11 x64, Windows 11 arm64. Windows 10
  arm64 is not supported (no x64 emulation there, and almost no devices).
- **Distribution:** GitHub Releases only — a per-user `Setup.exe` and a `.zip`
  per architecture, attached to the same `v<version>` tag as the Mac build.
  Unsigned at first: Windows shows the SmartScreen "Windows protected your PC"
  screen once ("More info → Run anyway"). Signing plugs in later through Forge's
  `windowsSign` without other changes.
- **No updater.** Users download new versions from Releases.
- **Not on Windows in the first release:** the screen saver, pairing
  (controlling another computer either way, hosting, file transfer, phone
  control), the global `eos` CLI. Hidden by capability, never by an OS check in
  the UI. Pairing follows in the next release (Phase 5).
- **Kept:** every agent lane, Code-view terminals, sync, notifications, tray,
  genui, location.
- **Test machines:** a Windows 11 arm64 VM on the Mac (Parallels/UTM) for hands-on
  work; the x64 build is smoke-tested inside it under x64 emulation. Real x64
  hardware and Windows 10 are covered by CI only (its runners are Windows
  Server) — one install on a real Windows 10 PC before release.

## The platform seam

- `process.platform` is read in exactly two places: `infra/src/platform/index.ts`
  (picks the daemon's `hostPlatform`) and `app/src/main/platform/index.ts` (the
  shell's `shellPlatform`). `manager/__tests__/platform-guard.test.ts` scans
  every package's source and fails any other read. Outside it: build tooling
  and the macOS-only dev CLI (`manager/cli`, `manager/builder`).
- **Daemon side — `HostPlatform`** (`infra/src/platform/HostPlatform.ts`; it
  lives in infra because no core use-case calls it). Adapters `darwin.ts`,
  `win32.ts`, `generic.ts` (any other system). It holds:
  - `controlSocket(home)` — `control-socket.ts`, shared with the app: a socket
    file, or on Windows the named pipe `\\.\pipe\eos-<hash of home>`.
  - `credentials` — the claude login store (Keychain / the CLI's
    `.credentials.json`) and provider API keys (Keychain / DPAPI files under
    `~/.eos/secrets`).
  - `trash`, `keepAwake`, `friendlyComputerName`, `fdCeiling`,
    `nativeRecursiveWatch`.
  - `createFsHelpers` — desktop integration (`infra/src/filesystem/FsHelpers.ts`):
    pickers, open / reveal / open-in-editor, installed editors, default app, icons.
  - `shell` — terminal tabs, `!` commands, the Code-view claude command
    (`interactive`, `run`, `orElse`, `ttyHooks`).
  - `scriptShell()` — the POSIX sh agents' command lines run in (goal checks,
    the in-process lanes' Bash tool).
  - `features` — `{ remote, posixShell }`, sent to the dashboard in
    `GET /api/ui-config`.
- **Shell side — `ShellPlatform`** (`app/src/main/platform/ShellPlatform.ts`;
  adapters `darwin.ts` + `darwin/`, `win32.ts` + `win32/`): `uiOS` (→
  `<html data-os>`), `init`, `appMenu`, window frame, splash material, daemon
  start/stop, control socket, packaged claude binary, location helper,
  clipboard file paths, notification sound, rebuild, screen saver.
- **Dashboard** — `app/ui/src/lib/platform.js` reads `<html data-os>` (set by the
  preload) for desktop conventions only: the command key (`modifiers`,
  `modDown`), shortcut labels (`shortcutLabel`, `modLabel`), the file manager's
  name. What the host offers comes from `state/featuresStore.js` (ui-config
  `features`). Paths are recognized by shape (`lib/pathLinks.js`: drive letters,
  UNC, backslashes under a Windows cwd), so a Mac viewing a Windows host reads
  them too.
- **`EosHelper.exe`** (`app/helper-win`, C# native AOT, one build per arch) is
  the Windows twin of the Swift helpers: `protect` / `unprotect` (DPAPI),
  `trash`, `keep-awake <pid>`, `location <timeoutS>` (same JSON as the macOS
  helper). The app passes its path to the daemon as `EOS_HELPER_BIN`.

## What differs on Windows

| Area | macOS | Windows |
|---|---|---|
| Daemon supervision | launchd agent (crash restart, process-group reap) | the app supervises its daemon (`win32/supervise.ts`): detached child, restarted after a crash (5×), `taskkill /T` on stop. A scheduled task can't carry the env the daemon is configured by, and the app stops its daemon on quit anyway |
| Control plane | `~/.eos/daemon.sock`, mode `0600` | named pipe; see *Control plane* |
| Claude login | Keychain item per store | `<store>/.credentials.json` |
| Provider API keys | Keychain (secret on argv) | DPAPI via EosHelper (secret on stdin) |
| Terminal shell | login `$SHELL` | PowerShell 7 if installed, else Windows PowerShell |
| Agents' `sh` commands | `/bin/sh` | Git for Windows' bash; missing ⇒ `features.posixShell=false` and the composer shows a download notice |
| Code-view claude hooks | `EOS_TTY` + OSC 7777 | none (`ttyHooks: false`): the pinned session id stands, a `/clear` inside isn't followed, open dialogs aren't reported (only the phone reads those) |
| Open / reveal / editors | `open`, `open -R`, URL schemes | `explorer.exe`, `/select,`, the editor's exe (`--goto` for VS Code / Cursor) |
| Pickers | osascript | the app's Electron dialogs over the browser-host RPC (`dialog.pickDirectory` / `dialog.pickFiles`) |
| Default app, app icons | Swift helper + `sips` | not resolved: generic glyphs |
| Trash | Finder | Recycle Bin (EosHelper) |
| Keep-awake | `caffeinate` | EosHelper (`SetThreadExecutionState`) — used once pairing ships |
| Location | `EosLocation.app` | EosHelper (WinRT `Geolocator`) |
| App menu | menu bar owns ⌘C/⌘V/⌘Z | none (`appMenu: false`), so every key reaches the dashboard and a terminal's Ctrl+C stays an interrupt |
| Window frame | `hiddenInset` + tuned traffic lights | `titleBarStyle:"hidden"` + `titleBarOverlay` (40px); the top-right pane header (`.pane-head--topright`) leaves the caption buttons' width |
| Splash | `vibrancy:"popover"` | `backgroundMaterial:"acrylic"` (Windows 11) |
| Notifications | banner + `eos-notification.aiff` | toast with the system sound, AppUserModelID `com.ibrahimalbyrk.eos` |
| Keys | ⌘ / ⌃ | Ctrl / Win; the terminal's Mac line-editing remaps and ⌘A select-all are off |
| Clipboard file paths | `NSFilenamesPboardType` | `FileNameW` (the first copied item) |
| Screen saver, rebuild | tray items | absent |
| Installer | — | Eos Setup (`app/installer-win`, see *Eos Setup*) |

Unchanged: core, contracts, SQLite, SSE, sync, genui, the React UI's design.
Fonts are bundled and liquid glass is Chromium's own `backdrop-filter`.

## Control plane on Windows

The socket exists so local callers don't burn ephemeral TCP ports; that holds on
Windows too, so the daemon serves the same router on a named pipe and clients
keep falling back to TCP without it (`EOS_DAEMON_SOCK` carries the pipe name).

On macOS the socket file's `0600` mode is the access check. A pipe has no file
mode and Node can't set its DACL; the default one gives other local accounts
read access only, which can't send a request. Phase 0 confirms it. If another
account turns out to be able to write, the pipe requires the ui-token like the
TCP port does.

`0600` files (`ui-token`, `sync/identity.json`, peer keys) rely on the per-user
profile ACL (user, SYSTEM, Administrators); `chmod` is a no-op there.

## Agent lanes on Windows

- **claude-sdk / claude-cli:** the SDK ships `win32-x64` / `win32-arm64`
  packages (`claude.exe`). Claude Code's Bash tool wants Git for Windows too.
- **codex-cli / gemini-cli:** Phase 0 confirms the read-only + `untrusted`
  setup still routes every command through the gateway.
- **Gateway (Bun):** native arm64 if it holds up; otherwise x64 Bun under
  Windows 11's emulation.

## Build, CI, release

- `.github/workflows/windows.yml`: `windows-latest` (x64) and `windows-11-arm`
  (arm64) each install, run the suites (non-blocking until they pass on
  Windows), `npm run make`, and upload `Eos-Setup-<arch>.exe` +
  `Eos-win32-<arch>.zip`. A published release (tagged by `scripts/release.sh` on
  the Mac) gets them attached.
- `forge.config.js`: native helpers per system in `prePackage`
  (`build-helper.mjs` needs the .NET 8 SDK), per-system `extraResource`,
  `maker-zip`, then a `postMake` hook wraps the zip in Eos Setup
  (`scripts/build-installer.mjs`), `build/icon.ico`.
- `scripts/assemble-daemon.mjs` ships the claude package and rebuilds node-pty
  for the machine it runs on; `scripts/ensure-dev.mjs` prepares `npm start` on
  either system.

## Eos Setup

The Windows installer, `app/installer-win` (Rust: tao + wry over WebView2,
which Windows 10 and 11 ship). Its window is `ui/index.html` — the design's
three steps (Choose · Install · Open Eos) plus a failure screen — talking to
`src/main.rs` over JSON messages; fonts and the logo are embedded, nothing is
fetched. `scripts/build-installer.mjs` builds it per arch and appends Forge's
zip behind it with a footer (`src/payload.rs`): `Eos-Setup-<arch>.exe`.

- **Where:** `%LOCALAPPDATA%\Programs\Eos` by default, or any empty folder
  (a folder that isn't empty and isn't Eos's is refused). Per user, no admin.
- **What it adds:** Desktop and Start menu shortcuts (with Eos's
  AppUserModelID, which toasts need), the Run key for "Startup", an
  Apps & features entry, and `Uninstall Eos.exe` — the same exe without its
  payload. All of it is listed in `<dir>\.eos-install.json`; reinstall,
  upgrade and uninstall delete only what that lists.
- **Flow:** stops a running Eos, uninstalls a 0.1.x Squirrel install, copies
  with live progress (cancel undoes the copy), adds the rest, opens Eos and
  steps aside.
- **Modes:** `--silent [--dir D] [--no-launch]` (CI, managed installs);
  `Uninstall Eos.exe --uninstall [--silent]`.

## Phases

0. **Spike (Windows 11 arm64 VM).** Dev-run daemon + app from the repo, answer
   the open questions. Exit: a claude-sdk worker answers a message.
1. **Seam on macOS, no behavior change.** Done.
2. **Daemon on Windows.** Code written, not yet run on Windows: `win32.ts`,
   PowerShell, `WindowsFsHelpers`, EosHelper client, named pipe, Git Bash,
   Windows-aware path guards (`isPathInside`, `repoRelative`, `isSafeAbsPath`).
   Still open: `core.longpaths` on created worktrees; the remaining POSIX-only
   path checks in the transfer code (off on Windows).
3. **Shell + UI.** Code written, not yet run on Windows: `win32.ts` shell,
   title bar, keys, labels, paths, feature gating, Git notice. Still open: the
   overlay height and the top-right inset against real screenshots; Windows
   bindings for the ⌃-combos (Win+digit belongs to the taskbar); the composer's
   undo without an app menu.
4. **Packaging + CI + release.** Written: workflow, Eos Setup, icon, helper
   build. Exit: a clean install from a GitHub release in the VM on both arches.
5. **Next release: pairing.** Turn `features.remote` on, firewall flow for the
   peer port, keep-awake, phone control of a Windows host, Mac ↔ Windows peering
   and transfer.

## Open questions (Phase 0)

1. Named pipe default DACL — can another local account write to it?
2. Where `claude auth login` writes under `CLAUDE_SECURESTORAGE_CONFIG_DIR` on
   Windows, and whether the one-shot PTY sign-in works under ConPTY.
3. `delivery.ts` bracketed paste + `claudeKeys.ts` sequences under ConPTY.
4. node-pty for the Electron 42 ABI on win32-arm64.
5. Bun gateway on win32-arm64.
6. ~~`maker-squirrel` arm64 output~~ — replaced by Eos Setup.
7. EosHelper's native AOT build with CsWinRT (location) on both runners.
8. Liquid glass frame cost on typical Windows GPUs.
