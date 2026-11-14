# The first Rust release

The first Rust build of Eos reaches users through the updater that is already in the field: the
TypeScript-era app (0.1.3 – 0.1.5) downloads it, stages it and swaps it in. Nothing of that old code
can be changed any more. This file says what the old code does, what the Rust bundle must therefore
contain and do, what could not be checked without a real release, and how to rehearse it on a spare
Mac.

Versions 0.1.0 – 0.1.2 have no in-app updater; they move through `install.sh` as before. Windows
pointers (`stable/win32-*.json`) stay where they are until there is a Rust build for Windows.

## 1. What the installed app does

| Step (old code) | Where |
|---|---|
| Reads `stable/darwin-arm64.json` from the feed (`config.updates.feedUrl`, else `https://updates.ibrahimalbyrk.dev`), checks the Ed25519 signature against the keys compiled into it, takes the release when its version is higher | `HttpUpdateFeed`, `CheckForUpdate` |
| Fetches the manifest the pointer pins (sha256, size), requires `format: 1`, checks paths and links | `manifestProblem` |
| Indexes its own bundle with the chunker, fetches the byte ranges of the chunks it lacks, checks each chunk's sha256 | `planUpdate`, `FsUpdateWorkspace.putRange` |
| Builds the whole tree under `~/.eos/updates/staged/<version>/Eos.app` — files, modes (`& 0o777`), links; nothing else — and scans it against the manifest | `FsUpdateWorkspace.stage` |
| Strips the quarantine flag, then requires: the same `TeamIdentifier` as the installed app, `codesign --verify --deep --strict`, `spctl --assess --type execute` | `MacAppBundleCheck` |
| On restart: verifies again, writes `~/.eos/updates/apply.json`, stops its launchd daemon (`com.ibrahimalbyrk.eos.daemon`), starts its applier, quits | `startMacUpdate` |
| Applier: waits for the app to exit (≤ 30 s), `launchctl bootout` once more, renames `/Applications/Eos.app` → `~/.eos/updates/previous/Eos.app`, renames the staged copy into place, deletes `boot-ok`, runs `open /Applications/Eos.app` | `app/src/updater/apply.ts` |
| Waits **120 s** for `~/.eos/updates/boot-ok` to hold `{"version":"<the new version>"}`. With it: `result.json` = `updated`. Without it: kills every process whose command line names the bundle, puts the old app back, `result.json` = `rolled-back`, opens the old app | same |
| After a rollback the old app never fetches that version by itself again | `UpdateService.skipVersion` |

## 2. What the Rust bundle must contain

| Requirement | Why | How it is met |
|---|---|---|
| Version `major.minor.patch`, higher than 0.1.5, and the same in the pointer, the manifest and `Contents/Resources/update.json` | the old applier waits for exactly the pointer's version in `boot-ok`; the new app writes the version of its `update.json` | `cargo xtask publish-update` refuses an app whose `update.json` names another version or is missing |
| `Contents/Resources/update.json` = `{"version":"…","channel":"stable","platform":"darwin-arm64"}` | without it the Rust app is "a build from source" and never updates itself again | `EOS_UPDATE_CHANNEL=stable host/scripts/bundle.sh release`; the version is the host workspace's (`host/Cargo.toml`) |
| Bundle identifier `com.ibrahimalbyrk.eos`, executable `Contents/MacOS/Eos` | the app keeps its identity: privacy grants, notifications, `eos://` links; the old applier opens the bundle at the old path | `EOS_BUNDLE_ID=com.ibrahimalbyrk.eos` (the script's default is a development id) |
| Signed by the same Developer ID team as 0.1.x, hardened runtime and a secure timestamp on every Mach-O, notarized, ticket stapled **before** publishing | the old daemon compares teams and asks `codesign` and Gatekeeper about the staged copy, offline | the release signing step (not `host/scripts/sign.sh` as it is: that one signs with `--timestamp=none` and notarizes nothing) |
| The signature must survive a rebuild from files, modes and links alone | the staged copy carries no extended attributes, no ACLs, no hard links, no special mode bits | every non-Mach-O file under `Contents/Resources` (sealed as a resource); no script under `Contents/MacOS` or `Contents/Helpers` — a signed script keeps its signature in extended attributes, which the update drops |
| `Contents/MacOS/eos-apply`, signed on its own | the Rust app's applier for every later update | `bundle.sh` copies it, `sign.sh` signs it |
| Feed: same URL, same key (`eos-update-signing`), manifest format 1, same chunker, one zstd frame per chunk, the pointer uploaded last | every installed app reads exactly this | `cargo xtask publish-update`: byte for byte what `scripts/publish-update.sh` writes for the same bundle (`crates/eos-update/tests/publish.rs`, `fixtures/update`) |

Anything else may change: the layout below `Contents`, the frameworks, `Resources/daemon` going
away. The update format describes a tree; it does not care what is in it.

## 3. What the Rust app must do on its first start

In this order. The first three are in `eos-app` (`App::build`), the fourth is one call the `eos`
binary makes.

1. **Stop the old daemon.** `eos_update::legacy::stop_legacy_daemon`: `launchctl bootout
   gui/<uid>/com.ibrahimalbyrk.eos.daemon`, then wait up to 12 s for it to be gone. After an in-app
   update this finds nothing (the old shell and the old applier both stopped it); it matters when
   the Rust app is installed by hand over a running 0.1.x. Only a release build running on `~/.eos`
   does this; a development build, a test or a run on another data folder never touches launchd.
   The old app loads its daemon again whenever it starts, so a rollback undoes this by itself.
2. **Snapshot before the first open.** `StartupBackup` clones the user's data into
   `~/.eos/backups/<stamp>/` before `state.db` is opened (three kept, none younger than an hour).
3. **Change nothing the old app cannot read, until `boot-ok` is written.** If this version fails to
   report in, 0.1.x comes back and opens the same `~/.eos`.
   - `state.db` opens in place. Migrations add tables only; the old runner applies its own list and
     ignores ids it does not know (`infra/src/persistence/MigrationRunner.ts`).
   - The start-up work on the rows (prune delivered messages, cut event logs, deny expired asks,
     park rows whose process died) is what the old daemon does at its own start.
   - A chat keeps the Claude Code session the old app resumes it by (`workers.session_id`); the
     Rust app keeps its own in `engine_sessions` (067, which also puts back the session an earlier
     Rust build had overwritten, from the chat's newest resume row). After going back, a chat from
     before the switch continues in 0.1.x from its last Claude Code state: the turns made in the
     Rust app stay visible in its history but are not in the model's context. A chat begun in the
     Rust app has no Claude Code session, so 0.1.x cannot continue it (its history stays). Coming
     back to Rust, a chat 0.1.x went on with continues from that newer Claude Code conversation;
     any other from the Rust app's own record.
   - `updates/last-version` is rewritten to the new version. After a rollback the old app reads a
     higher version than its own there and shows nothing for it; the rollback notice comes from
     `result.json`.
   - Every other feature is held to the same rule by `ARCHITECTURE.md` ("Data on disk keeps its
     formats"). It is checked by the rehearsal in §6, not by a test.
4. **Write `boot-ok` in time.** `App::mark_update_booted()` — once the core has started and the
   window is up. It writes `{"version":"<update.json's version>"}` to `~/.eos/updates/boot-ok` when
   `apply.json` says an applier is waiting, and then deletes `~/.eos/daemon.plist` (the old daemon's
   launchd plist, which holds its environment; the old app writes it again on every start).
   The 120 s run from the applier's `open`: Gatekeeper's first look at a new bundle of several
   hundred megabytes, the snapshot, the database, the window. Anything slow that can wait is
   deferred already (browser-profile snapshot, plugin scan).

`~/Library/Application Support/Eos` (the Electron profile) is only read, through a copy. The Rust
shell keeps its own data under `~/Library/Application Support/com.ibrahimalbyrk.eos`.

## 4. How the shell is wired

`eos-app` offers three things and the `eos` binary (`host/eos/src/main.rs`) uses them:

| When | Call |
|---|---|
| before `App::build` | `Options.update_applier` = `eos_update::handover::ApplierLauncher` over `Handover::beside(<executable>, <data folder>)` and the shell's `Ports.quit`, behind the shell's `Ports.splash` (`eos/src/main.rs` `WithSplash`) |
| `Hooks::started` (the dashboard is loading) | `app.mark_update_booted()`, then `app.update_signals().window_shown()` |
| `Hooks::window_shown` (Dock click, a later launch, a link) | `app.update_signals().window_shown()` |
| `Hooks::woke`, 10 s later | `app.update_signals().woke()` |

`ApplierLauncher` writes `apply.json`, copies `eos-apply` out of the bundle (a plain byte copy: no
quarantine flag travels with it) into `~/.eos/updates/`, starts it in its own process group and
then quits the app through `Ports.quit` (the normal quit: the core's shutdown runs). From the
hand-over until the app has quit, the "Updating · <from> → <to>" splash is up (a failed restart
closes it again); the new version opens after the swap.

A release build opens `~/.eos` when `EOS_HOME` is not set (`eos_bridge::launch`). A release must
run on `~/.eos`: only then is the old daemon stopped and its plist removed.

## 5. Publishing

```bash
# A signed, notarized, stapled Eos.app whose update.json says 0.2.0.
cargo xtask publish-update 0.2.0 --app <Eos.app> --notes <notes.md> \
    --feed https://updates.ibrahimalbyrk.dev --keychain
```

`--feed` only reads: the release on the feed now is what this one is built against (its chunks are
reused, its pack is referenced). `--previous <manifest>` does the same from a file. The command
writes the feed's files to `target/updates/0.2.0/` and prints the upload — immutable files first
with `--ignore-existing`, then the pointer through a temporary name. It uploads nothing itself.

Afterwards: `curl -s https://updates.ibrahimalbyrk.dev/stable/darwin-arm64.json` shows the new
version in its payload.

## 6. Rehearsal on a spare Mac

The old app reads its feed address from `~/.eos/config.json` (`updates.feedUrl`, https only), so a
spare install can be pointed at a private copy of the feed. The pointer there is signed with the
real key: only a Mac told to read that address ever sees it.

**Set-up**

1. A spare Mac (or VM) with 0.1.5 from `install.sh`. Use it: a few chats, a page, a template, a
   sign-in, so `~/.eos` holds real rows. Keep a copy of `~/.eos` and of `/Applications/Eos.app`.
2. Build, sign, notarize and staple the Rust bundle as in §2. `spctl -a -vv <Eos.app>` must say
   `source=Notarized Developer ID`; `codesign -dv --verbose=2` must show the team of 0.1.5.
3. `cargo xtask publish-update 0.2.0 --app <Eos.app> --feed https://updates.ibrahimalbyrk.dev
   --keychain --out /tmp/feed-0.2.0`.
4. On the feed's server, outside the public pointer: a folder such as `www/rehearsal-<random>/`
   holding hard links of the existing `packs/` and `releases/` (`cp -al`), plus the new files from
   step 3 (its `stable/darwin-arm64.json` goes **only** there).
5. On the spare Mac, with Eos quit: `"updates": { "feedUrl": "https://updates.ibrahimalbyrk.dev/rehearsal-<random>" }`
   in `~/.eos/config.json`.

**Runs** — after each, restore `~/.eos` and `/Applications/Eos.app` from the copies.

| Run | Do | Expect |
|---|---|---|
| A. Update | Open 0.1.5 → Settings › Updates → Check now → Restart | The Rust app opens within the 120 s. `~/.eos/logs/app-update.log` ends `done: updated`; `updates/result.json` is `updated`; the app shows its "updated from 0.1.5" notice; every chat, page, template and sign-in is there; `launchctl print gui/$(id -u)/com.ibrahimalbyrk.eos.daemon` finds nothing; `~/.eos/daemon.plist` is gone; `~/.eos/backups/` has a snapshot. Note the seconds between "apply" and "is up" in the log. |
| B. Rollback after the data was opened | Before Restart: `touch ~/.eos/updates/rehearse-rollback` | The Rust app opens fully and withholds `boot-ok`. After 120 s it is killed, 0.1.5 returns and opens the same data without loss; the log ends `done: rolled-back`; 0.1.5 shows that the update did not take and does not download 0.2.0 again. This is the run that proves §3.3. Delete the file afterwards. |
| C. From older versions | Run A from 0.1.3 and from 0.1.4 | As A. |
| D. Interrupted | Quit Eos while it downloads; turn the network off mid-download; quit during "Preparing" | The next start resumes from the ranges already fetched and ends as A. |
| E. A big data folder | Run A with the copy of a long-used `~/.eos` | As A; the seconds to "is up" stay far below 120. |
| F. Rust to Rust | From the Rust 0.2.0, publish 0.2.1 to the same private folder and update | `eos-apply` swaps the bundles; `updates/previous/Eos.app` now holds 0.2.0 (the Electron app it held before is gone). Then run B once more from Rust to Rust. |

Only when A – F pass: upload the same files to the public feed, pointer last.

## 7. What could not be verified here

- The Rust/CEF bundle signed with the real identity, notarized and stapled; and that a copy of it
  rebuilt from chunks — as the old daemon stages it — still passes `codesign --verify --deep
  --strict` and `spctl`. The release builder and the staging code are tested against bundles of
  invented files, never against a signed app.
- The old Electron applier acting on the new bundle: `open` launching it, Gatekeeper's first-launch
  time for it, and its kill of the CEF helper processes on a rollback.
- The time from `open` to `boot-ok` on a real data folder.
- That privacy grants and notification settings follow the bundle identifier across the swap.
- The real feed's server with the Rust client (range requests, redirects): the client ran only
  against a local stand-in. Installed 0.1.x apps fetch with their own client, as before.
- That no feature writes something in `~/.eos` before `boot-ok` that 0.1.x cannot read (run B).
- The shell wiring of §4 in a running app: it compiles and passes the host checks; no window was
  opened with it.

## 8. If the first release fails in the field

A Mac where 0.2.0 does not report in goes back to 0.1.x by itself and will not take 0.2.0 again on
its own. The fix is a new version number (0.2.1) on the feed; nothing has to be withdrawn. The
previous app the applier set aside stays in `~/.eos/updates/previous/` until the next update.
