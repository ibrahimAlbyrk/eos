# In-app updates

Eos finds a new version on its own, downloads only what changed in the
background, and asks to restart: the header beacon **Update** → popover →
**Restart now** → Eos quits, swaps the app and opens the new version.
Settings › Updates holds *Download updates automatically*, *Check now* and the
version. Design: the "Eos Updates" canvas — *B · Header beacon*,
*B · Settings › Updates*, *Restart moment*.

## What the numbers say

Measured on the published macOS zips (`Eos-darwin-arm64.zip`, 233 MB each):

| Update | Changed files | Whole changed files (zstd) | Missing chunks (zstd) |
|---|---|---|---|
| 0.1.1 → 0.1.2 | 31 · 426 MB raw | 154 MB | **0.8 MB** (37 chunks) |
| 0.1.0 → 0.1.2 | 168 · 444 MB raw | 158 MB | **2.6 MB** (221 chunks) |

The bundle is 567 MB in 779 files; Electron Framework (182 MB) and the bundled
`claude` binary (216 MB) are 70% of it.

1. **Signing re-stamps every Mach-O on every build.** The Developer ID
   signature and its secure timestamp live inside the file, so `claude` and
   Electron Framework "change" each release though their code doesn't. Any
   whole-file scheme (Squirrel, a plain file diff) re-downloads them — 154 MB
   for a release that changed almost nothing.
2. **The bytes that change are few and local** (the signature blob, the edited
   JS), so cutting files into content-defined chunks finds everything else in
   the copy that is already installed.
3. **zstd patches aren't available at runtime.** Electron 42 runs Node 24.18,
   whose zstd silently ignores `dictionary` (it works on Node 26), so
   `--patch-from`-style deltas can't be applied by the daemon or the app, and
   bsdiff would mean a native helper per platform. Chunks need only
   `node:crypto` and `node:zlib`.

## Approach: a content-addressed chunk store

- Every release is a **manifest** of the bundle's tree: dirs, symlinks
  (target), files (path, mode, size, sha256, ordered chunk ids).
- Files are cut with **FastCDC** (gear hash; min 16 KB, avg 64 KB, max 256 KB).
  A chunk's id is the sha256 of its bytes; boundaries follow content, so an
  edit moves only the chunks around it.
- Each release uploads **one pack** holding only the chunks no earlier release
  had, each zstd-compressed. The manifest's chunk table maps id → pack, offset,
  compressed size, size. When a file's new chunks compress worse than the whole
  file would (a rewritten minified bundle), the pack carries that file whole.
- The client indexes what is installed (same chunker), takes target chunks
  minus local chunks, fetches them with HTTP Range requests (adjacent ranges
  coalesced, 4 in parallel, resumable) and assembles a staged copy.

Why this:

- **Any version → any version.** Someone three releases behind downloads
  exactly what they lack; no per-pair patches to build or store.
- **Storage grows only by what is new**, and a static server is enough.
- **Self-healing.** A damaged local file has chunks that don't match; they
  simply come down too.
- **One chunker** (`core/src/domain/update/chunker.ts`, pure) serves the
  publisher and the client, so their boundaries can't drift.
- **No native code**: Node built-ins only, the same on macOS and Windows.

Not chosen: Squirrel.Mac / update.electronjs.org (the whole zip every time,
tied to GitHub); electron-updater blockmaps (shaped around electron-builder,
and its macOS path still swaps whole zips); zstd / bsdiff patches (no runtime
support / a native helper, and N×N patch files).

## Trust

- An Ed25519 key pair. The private key lives only on the release Mac (Keychain,
  next to the notary profile); the public key ships in `contracts/src/update.ts`.
- The pointer `stable/darwin-arm64.json` is signed: version, manifest sha256 and
  size, notes path, release time. Chain: pointer signature → manifest hash →
  chunk hashes → file hashes.
- A second, independent gate on macOS: the staged bundle must pass
  `codesign --verify --deep --strict` against our Team ID and `spctl --assess`
  (the notarization ticket is stapled, so this works offline). Every file is
  checked against the manifest, so the staged bundle is byte-identical to the
  notarized one.
- Never a downgrade (the pointer's version must be above the installed one),
  HTTPS only, hard caps on manifest and pack sizes. A compromised server can
  withhold an update, never ship one.

## Server: static files on the relay's VPS

The VPS that runs the relay (`zap-server`, 185.249.197.74; Debian 13, 2 vCPU,
4.5 GB RAM, 16 GB free; deploy notes in `relay/deploy/README.md`) serves the
updates too, the same way the relay coexists there: nothing of the existing
stack is modified or restarted.

- **`https://updates.ibrahimalbyrk.dev`** is baked into the app. The domain's
  DNS is on Cloudflare (`obsidian.ibrahimalbyrk.dev` already points at the
  VPS), so moving servers later is one DNS change; the zap.cloud name would
  die with the box. Needs one A record → 185.249.197.74, DNS only.
- **A small `eos-updates` container** (the `caddy:2` image already on the box)
  joins the `obsidian-sync_obsidian` network and serves `/opt/eos-updates/www`
  read-only with `file_server` (Range built in). The main Caddy only gains a
  site block, `reverse_proxy eos-updates:80`, and a graceful reload; its own
  container can't see host files without changing its compose file, which the
  relay deploy deliberately never does.
- **Cache headers:** packs, manifests and notes are immutable
  (`max-age=31536000, immutable`); the pointer is `no-cache`. That also lets
  the Cloudflare proxy be switched on later as a free CDN without code changes.
- **Deploy:** `update-server/deploy.sh` (idempotent, like the relay's: create
  dirs, (re)create only `eos-updates`, append the site block once with a
  `.bak`, `caddy validate` + `caddy reload`, verify).
- **Upload:** `rsync` over `ssh zap-server`; the pointer is written as `.tmp`
  and renamed, so it flips atomically and last.
- **Disk:** the first pack per platform is the whole bundle (~235 MB zstd),
  then each release adds MBs. Nothing is deleted on its own: a pack no current
  manifest references can be removed by hand once no one is on that version.
- **Moving later:** the signed pointer may carry `feedUrl`; an app that sees it
  stores the new base URL, so even a domain change reaches installed apps.

```
www/
  stable/darwin-arm64.json                      signed pointer, written last
  releases/0.1.3/darwin-arm64.manifest.json.zst
  packs/darwin-arm64/0.1.3.pack                 0.1.3's new chunks only
  notes/0.1.3.md                                "What's new"
```

`scripts/publish-update.mjs <version> [--platform darwin-arm64]`, run by
`release.sh` after notarize + staple on the same `Eos.app` that goes into the
GitHub zip (so a GitHub install's files match the manifest exactly): index it,
read the earlier manifests (the chunks that already exist), write the pack of
new ones, sign, upload pack → manifest → notes → pointer. The signing key is a
Keychain item (`eos-update-signing`), read with `security`, never on disk.

GitHub releases stay as they are for first installs: someone can download the
latest or any older release (0.1.3 or later); from then on the app updates
itself, from whatever version it is on, straight to the newest.

## Where each piece lives

The daemon checks, downloads and stages (it outlives the window and has the
bus, settings and Jobs); the app does the restart, since it owns its own
lifecycle.

| Layer | Pieces |
|---|---|
| contracts | `update.ts`: pointer, signed pointer, manifest, `UpdateStatus` / `UpdateState`, `UpdateApply`, `UpdateBuildInfo` (`Resources/update.json`), `UPDATE_FEED_URL`, `UPDATE_PUBLIC_KEYS`, `UPDATE_FILES`; routes in `http.ts`; local-only planes in `route-planes.ts` |
| core/domain/update | `version.ts`, `chunker.ts` (`ContentChunker`, streaming), `manifest.ts` (`manifestProblem`: paths, links, chunk refs), `plan.ts` (`planUpdate` → files to copy / assemble / take whole, coalesced pack ranges; `chunksWithin`), `status.ts` (allowed phase transitions), `errors.ts` (`UpdateError`) |
| core/ports | `Updates.ts`: `UpdateFeed`, `UpdateSignature`, `BundleIndexer`, `UpdateWorkspace`, `AppBundleCheck` |
| core/use-cases/update | `CheckForUpdate` (signature, platform, newer), `DownloadUpdate` (manifest → index → plan → 4 ranges at a time → stage → platform check) |
| infra/update | `bundleScan.ts` (the one reader of a bundle tree: publisher, index, staged check), `FsBundleIndexer`, `HttpUpdateFeed` (Range, retries with backoff, size caps), `ed25519.ts`, `FsUpdateWorkspace` (verified ranges, staging with APFS clones, `treeMismatch`, applier result), `MacAppBundleCheck` (same Team ID, `codesign --deep --strict`, `spctl`), `WinAppBundleCheck`, `buildRelease.ts` (publisher core) |
| infra/platform | `hostPlatform.appUpdates`: `feedPlatform`, `bundleRoot()`, `bundleCheck`, `fileModes` (darwin-arm64, win32-x64/arm64) |
| manager | `services/update/install.ts` (is this a release build in a writable folder), `services/update/UpdateService.ts` (when to check — see below; bus `update:change`; waits for agents; `update:apply`), `routes/update.ts`, config block `updates`, the download as a Jobs entry (`onUpdate`) |
| app (main) | `updates.ts` (update:apply → restart splash → platform hook → quit; boot-ok; the window showing and the Mac waking nudge a check), `platform/darwin/update.ts`, `platform/win32/update.ts`, `updater/apply.ts` (the macOS applier, its own esbuild entry) |
| installer-win | `src/update.rs`: Eos Setup's `--apply` mode (the Windows applier) |
| app/ui | `state/updateStore.js`, `lib/updates.js` (pure words), `views/update/UpdateBeacon.jsx` (pane header, beside `JobsBeacon`), `settings/UpdatesSettings.jsx`, `styles/update.css` |
| scripts | `publish-update.sh` (`--init-key`, `--dry-run`, `--from-release`), `release.sh` (builds with `EOS_UPDATE_CHANNEL=stable`, publishes after GitHub) |

Phases: `off · idle · checking · available · downloading {done, bytes} ·
staging · ready {bytes, full} · waiting {agents} · applying · error`. One
transition table in core; the UI only renders it. `available` is the
auto-download-off case; `off` (dev build, no updater on this system, a folder
Eos can't write) never changes.

When Eos looks for a release: 30 s after the daemon starts, then every 30 min
±20% (each install's own spread, so a release isn't asked for — and downloaded
— by everyone in the same minute); whenever the window shows (launch, Dock,
tray) and 10 s after the Mac wakes, unless a check ran in the last 10 min; and
on *Check now*, always (`POST /api/update/check {trigger}`). One check at a
time; the half-hour counts from the last one. A release reaches running apps
in ~15 min on average for one ~400-byte request per install per half hour.
No push channel: it would need a long-lived connection per app (a server
process, heartbeats, reconnect storms) and would send every install after a
release — and a bad release — at once; it can come later as a "check now"
signal over the relay without changing any of this.

Routes, all ui-token and LOCAL_ONLY (another computer never updates this one):
`GET /api/update`, `POST /api/update/{check,download,restart,later,dismiss}`,
`PUT /api/settings/updates`.

`~/.eos/updates/` is regenerable (left out of `shared/user-data.ts`):
`downloads/<version>/` (fetched ranges), `staged/<version>/`, `staged.json`,
`previous/` (the app set aside, kept until the next update), `apply.json`,
`boot-ok`, `result.json`, the applier copy. It sits on the installed app's
volume (`stat().dev`), else staging moves next to the app.

## Restart, swap, rollback

1. *Restart now* — or the idle edge after *When they finish* (no top-level
   agent WORKING) — makes the daemon re-verify the staged app and publish
   `update:apply`.
2. The app shows the restart splash ("Updating · 0.1.2 → 0.1.3"), writes
   `apply.json`, stops the daemon and starts the applier detached, then quits.
   - macOS: the old app's own binary as Node (`ELECTRON_RUN_AS_NODE`) runs
     `apply.cjs`, copied out of app.asar; App Management sees our Team ID.
   - Windows: `Uninstall Eos.exe` (Eos Setup without its payload) copied to
     `eos-apply.exe` and run with `--apply` — a running exe's folder can't move.
3. The applier stops what is left of Eos, moves the installed app to
   `previous/`, renames the staged copy into its place and opens it. On Windows
   it also carries the install record and the uninstaller across and updates
   the version Windows shows; Eos Setup gave Eos a folder of its own
   (`refuse_dir`), so the whole folder moves.
4. The new app writes `boot-ok` once its daemon answers and its window is up.
   No marker within 120 s → the applier stops the new version, puts the
   previous one back and opens it; `result.json` says `rolled-back`, and that
   version is never downloaded on its own again.
5. The next launch shows "Updated to 0.1.3" (or that it went back) once.

## Guards

- **Builds from source never update themselves.** `eos build` signs local
  builds with the same Developer ID into /Applications; an update would
  overwrite work in progress. Only `EOS_UPDATE_CHANNEL=stable` builds
  (`release.sh`, Windows CI on a release) carry `Resources/update.json`.
- A folder Eos can't write to (a non-admin user): `off`, Settings says why.
- The staged copy costs only the new bytes on APFS (clones); Windows copies.
- Files Eos writes itself carry no Mark-of-the-Web, so updates never trigger
  SmartScreen.

## Operating it

- **Release (macOS):** `bash scripts/release.sh <version>` builds, notarizes,
  publishes the GitHub release, then the same `Eos.app` to the feed.
- **Windows:** once `windows.yml` has attached its zips to the release:
  `bash scripts/publish-update.sh <version> --platform win32-x64 --from-release --notes docs/release/notes/v<version>.md`
  (and `win32-arm64`). Until a platform has a pointer on the feed, its apps see
  no update. The release Mac signs, so no key goes into GitHub secrets.
- **Signing key:** Keychain item `eos-update-signing` (and `EOS_UPDATE_SIGNING_KEY`
  in the gitignored `.env`). Losing it strands installed apps: keep a copy in a
  password manager. To rotate, add the new public key to `UPDATE_PUBLIC_KEYS`,
  ship a release, then sign with the new key.
- **Server:** `update-server/deploy.sh` (idempotent). Moving the feed: publish a
  pointer with `feedUrl`; apps that read it keep the new address.

## Status

All six phases are in: contracts + core, publisher + server, daemon, app
applier, UI, Windows. Verified on macOS end to end with the published 0.1.1 and
0.1.2 bundles (0.72 MB pack, staged copy byte-identical to 0.1.2 and accepted by
codesign + Gatekeeper) and the applier's swap and rollback against fake bundles.
Windows is type-checked (Rust for x64 and arm64, TypeScript) but not yet run on
a Windows machine.

0.1.2 has no updater, so **0.1.3 is the last version installed by hand**.
